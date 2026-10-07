'use strict';
/**
 * helper-bridge.js — Cầu nối giữa Node và SuperClipHelper.exe.
 *
 * Helper là một tiến trình .NET nhỏ, giao tiếp với Node qua stdin/stdout bằng
 * NDJSON (mỗi dòng một đối tượng JSON). Nhờ vậy Node không cần module native
 * nào mà vẫn:
 *   - nghe được sự kiện clipboard kèm SourceURL thật của trang web
 *   - biết cửa sổ nào đang được focus (nguồn copy / đích dán)
 *   - bắt được Ctrl+V ở tầng hệ điều hành (biết đã dán vào đâu)
 *   - đặt lại nội dung vào clipboard (text/HTML/ảnh/tệp) và xoá clipboard
 *   - đăng ký phím tắt toàn cục
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const HOTKEY_IDS = { palette: 1, main: 2 };

class HelperBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this.exePath = opts.exePath;
    this.tmpDir = opts.tmpDir;
    this.child = null;
    this.buf = '';
    this.stopping = false;
    this.restarts = [];
    this.state = {
      ready: false,
      pid: 0,
      version: '',
      arch: '',
      kbHookError: 0,
      lastFocus: null,
      recentWindows: [],
      hotkeys: {},
      lastPong: 0,
      latencyMs: 0,
    };
    this.pendingPing = null;
  }

  // ---------------------------------------------------------------- vòng đời

  start() {
    if (this.child) return;
    if (!fs.existsSync(this.exePath)) {
      this.emit('fatal', new Error('Không tìm thấy helper: ' + this.exePath));
      return;
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const args = ['--tmp', this.tmpDir];
    this.child = spawn(this.exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => this.emit('stderr', String(d).trim()));
    this.child.on('error', (e) => this.emit('fatal', e));
    this.child.on('exit', (code) => {
      this.child = null;
      this.state.ready = false;
      this.emit('exit', code);
      if (!this.stopping) this._maybeRestart();
    });
    this.emit('started');
  }

  _maybeRestart() {
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < 60000);
    if (this.restarts.length >= 5) {
      this.emit('fatal', new Error('Helper liên tục thoát — đã dừng khởi động lại'));
      return;
    }
    this.restarts.push(now);
    setTimeout(() => { if (!this.stopping) this.start(); }, 700);
  }

  stop() {
    this.stopping = true;
    try { if (this.child) { this._send({ cmd: 'quit' }); this.child.stdin.end(); } } catch { }
    const c = this.child;
    setTimeout(() => { try { if (c && !c.killed) c.kill(); } catch { } }, 500);
  }

  // ---------------------------------------------------------------- nhận dữ liệu

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
    if (this.buf.length > 8 * 1024 * 1024) this.buf = '';   // chống tràn
  }

  _dispatch(msg) {
    switch (msg.t) {
      case 'ready':
        this.state.ready = true;
        this.state.pid = msg.pid;
        this.state.version = msg.version;
        this.state.arch = msg.arch;
        this.emit('ready', this.state);
        break;
      case 'clip':
        this.emit('clip', msg);
        break;
      case 'focus': {
        const prev = this.state.lastFocus;
        this.state.lastFocus = msg;
        if (prev && prev.hwnd !== msg.hwnd) this._rememberWindow(prev);
        this.emit('focus', msg);
        break;
      }
      case 'paste':
        this.emit('paste', msg);
        break;
      case 'hotkey':
        this.emit('hotkey', msg.id);
        break;
      case 'hookfail':
        this.state.kbHookError = msg.code;
        this.emit('hookfail', msg);
        break;
      case 'error':
        this.emit('helper-error', msg);
        break;
      case 'pong':
        if (this.pendingPing) {
          this.state.latencyMs = Date.now() - this.pendingPing;
          this.state.lastPong = Date.now();
          this.pendingPing = null;
        }
        this.emit('pong', msg);
        break;
      case 'setok':
      case 'pasted':
      case 'hotkeyreg':
      case 'hotkeyunreg':
      case 'focusresult':
      case 'targetset':
        if (msg.t === 'hotkeyreg') this.state.hotkeys[msg.id] = !!msg.ok;
        if (msg.t === 'hotkeyunreg') delete this.state.hotkeys[msg.id];
        this.emit('ack', msg);
        break;
      default:
        this.emit('unknown', msg);
    }
  }

  _rememberWindow(w) {
    if (!w || !w.hwnd) return;
    const list = this.state.recentWindows.filter(x => x.hwnd !== w.hwnd);
    const self = /superclipboard|electron/i.test(w.proc || '');
    if (!self && w.title) {
      list.unshift({ hwnd: w.hwnd, proc: w.proc, title: w.title, exe: w.exe, ts: w.ts });
    }
    this.state.recentWindows = list.slice(0, 40);
  }

  // ---------------------------------------------------------------- gửi lệnh

  _send(obj) {
    if (!this.child || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch { return false; }
  }

  ping() { this.pendingPing = Date.now(); return this._send({ cmd: 'ping' }); }

  /** Đặt văn bản (kèm HTML + URL nguồn) vào clipboard. */
  setText(text, html, url) {
    return this._send({ cmd: 'settext', text: text == null ? '' : String(text), html: html || null, url: url || null });
  }

  /** Đặt ảnh (đường dẫn PNG) vào clipboard. */
  setImage(p) { return this._send({ cmd: 'setimage', path: p }); }

  setFiles(paths) { return this._send({ cmd: 'setfiles', paths: paths || [] }); }

  clearClipboard() { return this._send({ cmd: 'clearcip' }); }

  /** Gửi tổ hợp Ctrl+V vào một cửa sổ (mặc định: cửa sổ đang focus). */
  pasteTo(hwnd) { return this._send({ cmd: 'paste', hwnd: hwnd || 0 }); }

  focusTitle(title) { return this._send({ cmd: 'focus', title: title || '' }); }

  setTarget(hwnd) { return this._send({ cmd: 'target', hwnd: hwnd || 0 }); }

  snapshot() { return this._send({ cmd: 'snapshot' }); }

  /** mods: 1=Alt, 2=Ctrl, 4=Shift, 8=Win */
  registerHotkey(id, mods, vk) { return this._send({ cmd: 'hotkey', id, mods, vk }); }

  unregisterHotkey(id) { return this._send({ cmd: 'unhotkey', id }); }
}

module.exports = { HelperBridge, HOTKEY_IDS };
