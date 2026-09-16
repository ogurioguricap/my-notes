# =============================================================
#  在桌面创建「我的笔记」快捷方式
#  用法：右键本文件 → “使用 PowerShell 运行”
#        （或在 PowerShell 里执行： powershell -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1）
#  说明：只写桌面，不改动系统其它任何地方；右键快捷方式可随时删除。
# =============================================================
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

# 解析桌面路径（兼容 OneDrive 重定向）
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE 'OneDrive\桌面' }

Write-Host ''
Write-Host '  正在创建桌面快捷方式…' -ForegroundColor Cyan
Write-Host "  项目目录：$src"
Write-Host "  桌面：    $desktop"
Write-Host ''

$onlineUrl = 'https://ogurioguricap.github.io/my-notes/'
$portable = Join-Path $src "dist\我的笔记-离线版.html"
$launcher = Join-Path $src '打开我的笔记.html'

$ws = New-Object -ComObject WScript.Shell
$made = New-Object System.Collections.ArrayList

function New-UrlShortcut {
  param([string]$Name, [string]$Target)
  $path = Join-Path $desktop $Name
  try {
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = $Target
    $s.Save()
    [void]$made.Add($Name)
    Write-Host "  [完成] $Name" -ForegroundColor Green
  } catch {
    Write-Host "  [失败] $Name  ->  $($_.Exception.Message)" -ForegroundColor Red
  }
}

# 1) 线上版（最新内容，手机电脑通用）
New-UrlShortcut -Name '我的笔记（线上）.url' -Target $onlineUrl

# 2) 离线便携版（不联网双击即开）
if (Test-Path $portable) {
  New-UrlShortcut -Name '我的笔记（离线便携版）.url' -Target $portable
} else {
  Write-Host '  [跳过] 离线便携版还没生成，稍后运行 node tools/build-portable.mjs 即可' -ForegroundColor Yellow
}

# 3) 启动器面板（三种打开方式 + 使用说明）
if (Test-Path $launcher) {
  New-UrlShortcut -Name '打开我的笔记（启动器）.url' -Target $launcher
}

Write-Host ''
if ($made.Count -gt 0) {
  Write-Host "  已创建 $($made.Count) 个快捷方式，去桌面看看 👀" -ForegroundColor Cyan
  Write-Host '  建议把「我的笔记（线上）」拖到任务栏，以后一键就能打开。' -ForegroundColor Gray
} else {
  Write-Host '  一个都没创建成功。可以手动操作：' -ForegroundColor Yellow
  Write-Host "  1) 打开 $src" -ForegroundColor Gray
  Write-Host "  2) 右键「我的笔记.url」→ 发送到 → 桌面快捷方式" -ForegroundColor Gray
}
Write-Host ''
Write-Host '  按任意键关闭…' -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
