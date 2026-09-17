# =============================================================
#  在桌面创建「我的笔记」快捷方式（PowerShell 版，供 VBS 不可用时兜底）
#  用法：右键本文件 →「使用 PowerShell 运行」
#        或在 PowerShell 里执行： powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1
#  只写桌面，不动注册表、不改系统设置。
# =============================================================
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE 'OneDrive\桌面' }
if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop' }

$icon = Join-Path $src '我的笔记.ico'
$vbs = Join-Path $src '打开笔记.vbs'
$portable = Join-Path $src 'dist\我的笔记-离线版.html'
$launcher = Join-Path $src '打开我的笔记.html'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

Write-Host ''
Write-Host '  正在创建桌面快捷方式…' -ForegroundColor Cyan
Write-Host "  项目目录：$src"
Write-Host "  桌面路径：$desktop"
if (Test-Path $icon) { Write-Host '  自定义图标：我的笔记.ico OK' -ForegroundColor DarkGray }
else { Write-Host '  自定义图标：未找到，将用系统默认图标' -ForegroundColor Yellow }

$ws = New-Object -ComObject WScript.Shell
$made = 0

function Make-Link {
  param([string]$Name, [string]$Target, [string]$Arguments = '', [string]$Desc = '')
  if (-not (Test-Path $Target)) { Write-Host "  [跳过] $Name（目标不存在：$Target）" -ForegroundColor Yellow; return 0 }
  try {
    $lnk = $ws.CreateShortcut((Join-Path $desktop $Name))
    $lnk.TargetPath = $Target
    if ($Arguments) { $lnk.Arguments = $Arguments }
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    if ($Desc) { $lnk.Description = $Desc }
    $lnk.Save()
    Write-Host "  [完成] $Name" -ForegroundColor Green
    return 1
  } catch {
    Write-Host "  [失败] $Name -> $($_.Exception.Message)" -ForegroundColor Red
    return 0
  }
}

$made += Make-Link -Name '我的笔记.lnk' -Target $wscript -Arguments "`"$vbs`"" -Desc '打开我的笔记（线上，内容最新）'
$made += Make-Link -Name '我的笔记（离线版）.lnk' -Target $portable -Desc '不联网也能打开（单文件离线版）'
$made += Make-Link -Name '我的笔记（使用说明）.lnk' -Target $launcher -Desc '所有打开方式与使用说明'

Write-Host ''
if ($made -gt 0) {
  Write-Host "  已创建 $made 个快捷方式，去桌面看看 👀" -ForegroundColor Cyan
  Write-Host '  建议把「我的笔记」拖到任务栏，以后一键就能打开。' -ForegroundColor Gray
} else {
  Write-Host '  没有创建成功。手动办法：' -ForegroundColor Yellow
  Write-Host "  1) 打开文件夹：$src"
  Write-Host '  2) 把 我的笔记.ico 复制到桌面，再新建一个指向线上地址的快捷方式'
}
Write-Host ''
Write-Host '  按任意键关闭…' -ForegroundColor DarkGray
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch {}
