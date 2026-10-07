<#
  clip.ps1 — Thao tác clipboard cho mục đích kiểm thử.
  Phải chạy bằng Windows PowerShell (STA):
      powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File tools\clip.ps1 -Action ...
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Text = '',
  [string]$Url = '',
  [string]$Fragment = '',
  [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-CfHtml([string]$frag, [string]$url) {
  $tpl = "Version:1.0`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n"
  if ($url) { $tpl += "SourceURL:$url`r`n" }
  $pre = "<html><body><!--StartFragment-->"
  $post = "<!--EndFragment--></body></html>"
  $headerLen = ($tpl -f 0, 0, 0, 0).Length
  $startHtml = $headerLen
  $startFrag = $startHtml + $pre.Length
  $endFrag = $startFrag + [System.Text.Encoding]::UTF8.GetByteCount($frag)
  $endHtml = $endFrag + $post.Length
  return ($tpl -f $startHtml, $endHtml, $startFrag, $endFrag) + $pre + $frag + $post
}

switch ($Action) {
  'save' {
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      $img.Save("$Path.png", [System.Drawing.Imaging.ImageFormat]::Png)
      $img.Dispose()
      Write-Output 'image'
    }
    elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
      [System.IO.File]::WriteAllText("$Path.txt", [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false)))
      Write-Output 'text'
    }
    else { Write-Output 'empty' }
  }
  'restore' {
    if (Test-Path "$Path.png") {
      $img = [System.Drawing.Image]::FromFile("$Path.png")
      [System.Windows.Forms.Clipboard]::SetImage($img)
      $img.Dispose()
    }
    elseif (Test-Path "$Path.txt") {
      $t = [System.IO.File]::ReadAllText("$Path.txt", [System.Text.Encoding]::UTF8)
      [System.Windows.Forms.Clipboard]::SetText($t)
    }
    Write-Output 'restored'
  }
  'setrich' {
    $d = New-Object System.Windows.Forms.DataObject
    $d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $Text)
    if ($Fragment) { $d.SetData('HTML Format', (New-CfHtml $Fragment $Url)) }
    [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)
    Write-Output 'ok'
  }
  'settext' {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Write-Output 'ok'
  }
  'gettext' {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      $out = [System.Windows.Forms.Clipboard]::GetText()
      [System.IO.File]::WriteAllText("$Path.txt", $out, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output 'text'
    }
    else { Write-Output 'notext' }
  }
  'getimage' {
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      $img.Save("$Path.png", [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("{0}x{1}" -f $img.Width, $img.Height)
      $img.Dispose()
    }
    else { Write-Output 'noimage' }
  }
  'setimage' {
    $img = [System.Drawing.Image]::FromFile($Path)
    [System.Windows.Forms.Clipboard]::SetImage($img)
    $img.Dispose()
    Write-Output 'ok'
  }
  'clear' {
    [System.Windows.Forms.Clipboard]::Clear()
    Write-Output 'ok'
  }
  default { Write-Output "unknown action: $Action"; exit 2 }
}
