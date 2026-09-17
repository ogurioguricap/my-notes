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
  param([string]$Name, [string]$Target, [string]$IconPath = $null, [string]$Arguments = $null)
  $path = Join-Path $desktop $Name
  try {
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = $Target
    if ($Arguments) { $s.Arguments = $Arguments }
    if ($IconPath) { $s.IconLocation = $IconPath }
    $s.Save()
    [void]$made.Add($Name)
    Write-Host "  [完成] $Name" -ForegroundColor Green
  } catch {
    Write-Host "  [失败] $Name  ->  $($_.Exception.Message)" -ForegroundColor Red
  }
}

# 图标：多尺寸 ICO（由 tools/make-icon.mjs 生成）
$iconFile = Join-Path $src '我的笔记.ico'
$icon = if (Test-Path $iconFile) { "$iconFile,0" } else { $null }
if ($icon) { Write-Host '  使用自定义图标：我的笔记.ico' -ForegroundColor DarkGray }
else { Write-Host '  [提示] 未找到 我的笔记.ico，将使用默认图标' -ForegroundColor Yellow }

# 启动器脚本（wscript 静默打开网站，.lnk 才能带自定义图标）
$vbs = Join-Path $src '打开笔记.vbs'

# 1) 线上版（带图标，双击直接开网站）
if (Test-Path $vbs) {
  New-UrlShortcut -Name '我的笔记.lnk' -Target "$env:SystemRoot\System32\wscript.exe" -IconPath $icon -Arguments "`"$vbs`""
  # 参数交给下面的辅助函数处理
} else {
  New-UrlShortcut -Name '我的笔记（线上）.url' -Target $onlineUrl
}

# 2) 离线便携版（不联网双击即开，也带图标）
if (Test-Path $portable) {
  New-UrlShortcut -Name '我的笔记（离线便携版）.lnk' -Target $portable -IconPath $icon
} else {
  Write-Host '  [跳过] 离线便携版还没生成，稍后运行 node tools/build-portable.mjs 即可' -ForegroundColor Yellow
}

# 3) 启动器面板（可视化编辑器 / 手写标注入口说明）
if (Test-Path $launcher) {
  New-UrlShortcut -Name '我的笔记（使用说明）.lnk' -Target $launcher -IconPath $icon
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
