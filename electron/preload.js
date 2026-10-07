'use strict';
/**
 * preload.js — Cầu nối an toàn giữa giao diện và Electron.
 * Giao diện vẫn chạy được trên trình duyệt thường (khi đó window.scHost là undefined).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scHost', {
  isDesktop: true,
  platform: process.platform,
  version: () => ipcRenderer.invoke('app:version'),
  /** Lưu tệp xuất (JSON hoặc báo cáo Markdown) vào thư mục Tải về. */
  saveFile: (kind) => ipcRenderer.invoke('app:save-file', kind),
  /** Mở thư mục chứa dữ liệu. */
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  /** Mở một URL bằng trình duyệt mặc định. */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});
