<#
  test-window.ps1 — Cửa sổ WinForms đóng vai "ứng dụng đích" khi kiểm thử.

  AN TOÀN: trước khi gửi Ctrl+V, cửa sổ tự kiểm tra xem nó có thực sự đang được
  focus hay không. Nếu không giành được focus sau nhiều lần thử, nó KHÔNG gửi gì cả
  và ghi "NOFOCUS" — tuyệt đối không dán nhầm vào ứng dụng khác của người dùng.
#>
param(
  [string]$Title = 'SuperClipboard Test Target',
  [int]$DelayMs = 2200,
  [int]$LifeMs = 5000,
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  public static bool IsMine(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    return pid == (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
  }
  public static bool Grab(IntPtr h) {
    if (IsMine(GetForegroundWindow())) return true;
    SetForegroundWindow(h);
    if (IsMine(GetForegroundWindow())) return true;
    uint fg; uint t = GetWindowThreadProcessId(GetForegroundWindow(), out fg);
    uint cur = GetCurrentThreadId();
    bool att = false;
    if (t != 0 && t != cur) att = AttachThreadInput(cur, t, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (att) AttachThreadInput(cur, t, false);
    if (IsMine(GetForegroundWindow())) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(12);
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return IsMine(GetForegroundWindow());
  }
}
"@

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Size = New-Object System.Drawing.Size(440, 170)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Name = 'target'
$form.Controls.Add($box)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $DelayMs
$timer.Add_Tick({
  $timer.Stop()
  $ok = $false
  for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
    $ok = [W]::Grab($form.Handle)
    if (-not $ok) { Start-Sleep -Milliseconds 120 }
  }
  if (-not $ok) {
    if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, 'NOFOCUS', (New-Object System.Text.UTF8Encoding($false))) }
    Write-Output 'NOFOCUS'
    $form.Close()
    return
  }
  Start-Sleep -Milliseconds 120
  try { [System.Windows.Forms.SendKeys]::SendWait('^v') } catch { }
  Start-Sleep -Milliseconds 500
  if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $box.Text, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output ('PASTED ' + $box.Text.Length)
  $form.Close()
})
$timer.Start()

Write-Output ("READY " + $PID)
[void]$form.ShowDialog()
$form.Dispose()
Write-Output 'CLOSED'
