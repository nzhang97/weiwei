<# : batch part (ASCII only) - double-click this file
@echo off
setlocal
set "SPL_SELF=%~f0"
set "SPL_ROOT=%~dp0"
if defined SPL_DEBUG (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -Command "iex ([IO.File]::ReadAllText($env:SPL_SELF,[Text.Encoding]::UTF8))"
  pause
) else (
  start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -Command "iex ([IO.File]::ReadAllText($env:SPL_SELF,[Text.Encoding]::UTF8))"
)
exit /b
#>
# =====================================================================================================================
# 启动器.cmd — 卫戍协议：盟约 图形启动器（Windows）。双击运行；不需要改 PowerShell 执行策略。
#   启动 / 停止 / 重启服务器（node server/index.js，PORT / HOST 环境变量），服务器输出显示在窗口里并写入
#   logs\launcher-server.log；打开网页、复制局域网地址；准备环境（npm ci + tools/setup.mjs）；更新代码（只快进）。
#   调试：在命令提示符里 set SPL_DEBUG=1 后运行本文件，可以看到 PowerShell 的报错。
# =====================================================================================================================
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# the window runs hidden: an unexpected error is shown instead of closing silently
trap { if ($env:SPL_TEST) { "ERROR: " + $_.Exception.Message + " @ " + $_.InvocationInfo.PositionMessage; break }; [void][System.Windows.Forms.MessageBox]::Show("启动器出错：`r`n" + $_.Exception.Message + "`r`n`r`n" + $_.InvocationInfo.PositionMessage, '卫戍协议：盟约 启动器', 'OK', 'Error'); break }
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = $env:SPL_ROOT
if (-not $Root) { $Root = (Get-Location).Path }
$Root = $Root.TrimEnd('\')
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'launcher-server.log'
$Title = '卫戍协议：盟约 启动器'

function Show-Msg([string]$text, [string]$caption, [string]$buttons = 'OK', [string]$icon = 'Information') {
  # SPL_TEST (no desktop): print instead of a modal box; answer No
  if ($env:SPL_TEST) { [Console]::Out.WriteLine("MSG: " + $text); if ($buttons -eq 'OK') { return 'OK' } else { return 'No' } }
  return [string][System.Windows.Forms.MessageBox]::Show($text, $caption, $buttons, $icon)
}
function Find-Node {
  if ($env:SPL_NODE -and (Test-Path -LiteralPath $env:SPL_NODE -ErrorAction SilentlyContinue)) { return $env:SPL_NODE }
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if ($p -and (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { return $p }
  }
  return $null
}
function Find-Git {
  $c = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) { if ($p -and (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { return $p } }
  return $null
}

$script:Node = Find-Node
$script:Proc = $null          # the cmd.exe that runs node (ours)
$script:Opened = $false       # the browser was opened for this start
$script:Starting = $false
$script:LogPos = 0
$script:Decoder = [System.Text.Encoding]::UTF8.GetDecoder()
$script:Tick = 0
$script:LastUp = $null

function Test-Port([int]$port) {
  $tc = New-Object System.Net.Sockets.TcpClient
  try { return $tc.ConnectAsync('127.0.0.1', $port).Wait(250) -and $tc.Connected } catch { return $false } finally { $tc.Close() }
}
function Get-LanAddresses {
  $out = @()
  try {
    foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($ni.OperationalStatus -ne 'Up' -or $ni.NetworkInterfaceType -eq 'Loopback') { continue }
      foreach ($ua in $ni.GetIPProperties().UnicastAddresses) {
        $a = $ua.Address
        if ($a.AddressFamily -ne 'InterNetwork') { continue }
        $s = $a.ToString()
        if ($s.StartsWith('169.254.') -or $s.StartsWith('127.')) { continue }
        $out += $s
      }
    }
  } catch { }
  return $out | Select-Object -Unique
}
function Get-ListenPid([int]$port) {
  try { return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1) } catch { }
  try {
    foreach ($l in (netstat -ano -p TCP | Select-String "LISTENING")) {
      $f = ($l.ToString().Trim() -split '\s+')
      if ($f.Length -ge 5 -and $f[1] -match "[:\]]$port$") { return [int]$f[4] }
    }
  } catch { }
  return $null
}
function Ours-Running { return ($script:Proc -ne $null -and -not $script:Proc.HasExited) }

# ---------------------------------------------------------------------------------------------------------------- UI
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Size = New-Object System.Drawing.Size(860, 600)
$form.MinimumSize = New-Object System.Drawing.Size(720, 460)
$form.StartPosition = 'CenterScreen'
$form.Font = $font

$top = New-Object System.Windows.Forms.FlowLayoutPanel
$top.Dock = 'Top'; $top.AutoSize = $true; $top.WrapContents = $true; $top.Padding = New-Object System.Windows.Forms.Padding(8, 8, 8, 0)

function New-Button($text, $w = 96) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Width = $w; $b.Height = 30; $b.Margin = New-Object System.Windows.Forms.Padding(3)
  return $b
}
function New-Label($text) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.AutoSize = $true; $l.Margin = New-Object System.Windows.Forms.Padding(3, 9, 3, 3)
  return $l
}

$lblStatus = New-Label '● 已停止'
$lblStatus.ForeColor = [System.Drawing.Color]::Gray
$lblStatus.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$lblStatus.Width = 150; $lblStatus.AutoSize = $false; $lblStatus.Height = 24

$lblPort = New-Label '端口'
$numPort = New-Object System.Windows.Forms.NumericUpDown
$numPort.Minimum = 1; $numPort.Maximum = 65535; $numPort.Value = 3000; $numPort.Width = 70
$numPort.Margin = New-Object System.Windows.Forms.Padding(3, 6, 3, 3)
if ($env:PORT -match '^\d+$') { $numPort.Value = [int]$env:PORT }

$chkOpen = New-Object System.Windows.Forms.CheckBox
$chkOpen.Text = '启动后自动打开网页'; $chkOpen.Checked = $true; $chkOpen.AutoSize = $true
$chkOpen.Margin = New-Object System.Windows.Forms.Padding(10, 8, 3, 3)
$chkLocal = New-Object System.Windows.Forms.CheckBox
$chkLocal.Text = '仅本机访问'; $chkLocal.Checked = $false; $chkLocal.AutoSize = $true
$chkLocal.Margin = New-Object System.Windows.Forms.Padding(10, 8, 3, 3)
$chkNoAssets = New-Object System.Windows.Forms.CheckBox
$chkNoAssets.Text = '准备环境时跳过美术资源下载'; $chkNoAssets.Checked = $false; $chkNoAssets.AutoSize = $true
$chkNoAssets.Margin = New-Object System.Windows.Forms.Padding(10, 8, 3, 3)
# 每轮自选 (SP_FREE_PICK, default off): every round a player may take one operator up to the own shop level for free (not
# banned, from the shared pool); an unused pick carries over. Read at server start: restart the server after a change.
$chkFreePick = New-Object System.Windows.Forms.CheckBox
$chkFreePick.Text = '每轮自选干员（不超过商店等级，未用次数保留）'; $chkFreePick.Checked = ($env:SP_FREE_PICK -match '^(1|on|true|yes)$'); $chkFreePick.AutoSize = $true
$chkFreePick.Margin = New-Object System.Windows.Forms.Padding(10, 8, 3, 3)

$row1 = New-Object System.Windows.Forms.FlowLayoutPanel
$row1.AutoSize = $true; $row1.WrapContents = $true; $row1.Width = 820
$btnStart = New-Button '启动服务器'
$btnStop = New-Button '停止服务器'
$btnRestart = New-Button '重启'
$btnOpen = New-Button '打开网页'
$btnCopy = New-Button '复制局域网地址' 120
$btnSetup = New-Button '准备环境'
$btnUpdate = New-Button '更新代码'
$btnFolder = New-Button '打开文件夹'
$btnClear = New-Button '清空日志'
foreach ($c in @($btnStart, $btnStop, $btnRestart, $btnOpen, $btnCopy, $btnSetup, $btnUpdate, $btnFolder, $btnClear)) { [void]$row1.Controls.Add($c) }

$lblAddr = New-Label ''
$lblAddr.Margin = New-Object System.Windows.Forms.Padding(6, 4, 3, 6)
$lblAddr.ForeColor = [System.Drawing.Color]::FromArgb(30, 90, 160)

foreach ($c in @($lblStatus, $lblPort, $numPort, $chkOpen, $chkLocal, $chkNoAssets, $chkFreePick)) { [void]$top.Controls.Add($c) }
$top.SetFlowBreak($chkFreePick, $true)
[void]$top.Controls.Add($row1)
$top.SetFlowBreak($row1, $true)
[void]$top.Controls.Add($lblAddr)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'; $log.WordWrap = $true
$log.Dock = 'Fill'; $log.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 28); $log.ForeColor = [System.Drawing.Color]::FromArgb(220, 220, 220)
$log.Font = New-Object System.Drawing.Font('Consolas', 9.5)

$form.Controls.Add($log)
$form.Controls.Add($top)

function Add-Log([string]$s) {
  if (-not $s) { return }
  $s = [regex]::Replace($s, ([string][char]27) + '\[[0-9;?]*[A-Za-z]', '')
  $s = $s -replace "(?<!`r)`n", "`r`n"
  if ($log.TextLength -gt 400000) { $log.Text = $log.Text.Substring($log.TextLength - 200000) }
  $log.AppendText($s)
}
function Say([string]$s) { Add-Log ("[启动器 " + (Get-Date -Format 'HH:mm:ss') + "] " + $s + "`r`n") }
function Url { return "http://localhost:$([int]$numPort.Value)" }

function Update-Addr {
  $p = [int]$numPort.Value
  $lan = @(Get-LanAddresses)
  $t = "本机：http://localhost:$p"
  if ($chkLocal.Checked) { $t += "    （仅本机访问，局域网无法连接）" }
  elseif ($lan.Count) { $t += "    局域网：" + (($lan | ForEach-Object { "http://${_}:$p" }) -join '   ') }
  $lblAddr.Text = $t
}

function Refresh-State {
  $p = [int]$numPort.Value
  $up = Test-Port $p
  $ours = Ours-Running
  if ($script:Proc -ne $null -and $script:Proc.HasExited -and $script:Starting -eq $false -and $script:LastUp -ne 'exited') {
    Say ("服务器进程已退出（代码 " + $script:Proc.ExitCode + "）")
    $script:LastUp = 'exited'
  }
  if ($up) {
    $lblStatus.Text = if ($ours) { '● 运行中' } else { '● 运行中（外部）' }
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(20, 150, 70)
    if ($script:Starting) {
      $script:Starting = $false
      Say ("服务器已启动：" + (Url))
      if ($chkOpen.Checked -and -not $script:Opened) { $script:Opened = $true; Open-Web }
    }
    $script:LastUp = 'up'
  } elseif ($ours) {
    $lblStatus.Text = '● 启动中…'
    $lblStatus.ForeColor = [System.Drawing.Color]::DarkOrange
  } else {
    $lblStatus.Text = '● 已停止'
    $lblStatus.ForeColor = [System.Drawing.Color]::Gray
    $script:Starting = $false
  }
  $btnStart.Enabled = -not $up -and -not $ours
  $btnStop.Enabled = $up -or $ours
  $btnRestart.Enabled = $up -or $ours
  $numPort.Enabled = -not $up -and -not $ours
  $chkLocal.Enabled = -not $ours
}

function Read-NewLog {
  if (-not (Test-Path $LogFile)) { return }
  try {
    $fs = [System.IO.File]::Open($LogFile, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      if ($fs.Length -lt $script:LogPos) { $script:LogPos = 0 }
      if ($fs.Length -eq $script:LogPos) { return }
      [void]$fs.Seek($script:LogPos, 'Begin')
      $n = [int][Math]::Min(1048576, $fs.Length - $script:LogPos)
      $buf = New-Object byte[] $n
      $got = $fs.Read($buf, 0, $n)
      $script:LogPos += $got
      $chars = New-Object char[] ($script:Decoder.GetMaxCharCount($got))
      $cn = $script:Decoder.GetChars($buf, 0, $got, $chars, 0)
      Add-Log (New-Object string($chars, 0, $cn))
    } finally { $fs.Close() }
  } catch { }
}

function Open-Web {
  try { Start-Process (Url) } catch { Say ("无法打开浏览器：" + $_.Exception.Message) }
}

function Start-Server {
  if (Ours-Running) { return }
  if (-not $script:Node) { $script:Node = Find-Node }
  if (-not $script:Node) {
    [void](Show-Msg ("没有找到 Node.js（需要 22 或更高版本）。`r`n`r`n安装方法：在 PowerShell 里运行  winget install OpenJS.NodeJS.LTS`r`n或从 https://nodejs.org/zh-cn/download 下载安装，装好后重新打开启动器。") $Title 'OK' 'Warning')
    return
  }
  $p = [int]$numPort.Value
  if (Test-Port $p) {
    $r = (Show-Msg ("端口 $p 已经有程序在监听（服务器可能已经在运行）。`r`n要直接打开网页吗？") $Title 'YesNo' 'Question')
    if ($r -eq 'Yes') { Open-Web }
    return
  }
  if (-not (Test-Path (Join-Path $Root 'node_modules\ws\package.json'))) {
    $r = (Show-Msg ("还没有安装依赖（node_modules）。现在打开一个窗口执行「准备环境」吗？`r`n完成后再点「启动服务器」。") $Title 'YesNo' 'Question')
    if ($r -eq 'Yes') { Run-Setup }
    return
  }
  if (-not (Test-Path $LogDir)) { [void](New-Item -ItemType Directory -Path $LogDir) }
  Set-Content -Path $LogFile -Value '' -NoNewline -Encoding Ascii
  $script:LogPos = 0
  $script:Decoder = [System.Text.Encoding]::UTF8.GetDecoder()
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /s /c `"`"$($script:Node)`" server\index.js >> `"$LogFile`" 2>&1`""
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['PORT'] = "$p"
  $psi.EnvironmentVariables['NO_COLOR'] = '1'
  $psi.EnvironmentVariables['FORCE_COLOR'] = '0'
  if ($chkFreePick.Checked) { $psi.EnvironmentVariables['SP_FREE_PICK'] = '1' } elseif ($psi.EnvironmentVariables.ContainsKey('SP_FREE_PICK')) { $psi.EnvironmentVariables.Remove('SP_FREE_PICK') }
  if ($chkLocal.Checked) { $psi.EnvironmentVariables['HOST'] = '127.0.0.1' } elseif ($psi.EnvironmentVariables.ContainsKey('HOST') -and -not $env:HOST) { $psi.EnvironmentVariables.Remove('HOST') }
  try {
    $script:ProcStart = (Get-Date).AddSeconds(-1)
    $script:Proc = [System.Diagnostics.Process]::Start($psi)
    $script:Starting = $true; $script:Opened = $false; $script:LastUp = $null
    Say ("正在启动服务器（端口 $p，Node：" + $script:Node + "）…")
    if ($chkFreePick.Checked) { Say '已开启：每轮自选干员（SP_FREE_PICK=1）' }
  } catch {
    Say ("启动失败：" + $_.Exception.Message)
  }
  Update-Addr
  Refresh-State
}

function Kill-Tree([int]$id) {
  # the node child first (cmd.exe → node.exe), then the whole tree with taskkill, bounded waits only
  $kids = @()
  try { $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction Stop | Select-Object -ExpandProperty ProcessId) } catch { }
  foreach ($k in $kids) { try { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue } catch { } }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\taskkill.exe"
    $psi.Arguments = "/PID $id /T /F"
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $k = [System.Diagnostics.Process]::Start($psi)
    [void]$k.WaitForExit(5000)
  } catch { }
  try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch { }
}

function Stop-Server([bool]$ask = $true) {
  if (Ours-Running) {
    $p = [int]$numPort.Value
    Kill-Tree $script:Proc.Id
    $script:Proc.WaitForExit(3000) | Out-Null
    # node.exe outliving its cmd.exe (taskkill / WMI unavailable): end whatever node still listens on our port
    for ($i = 0; $i -lt 10 -and (Test-Port $p); $i++) { Start-Sleep -Milliseconds 200 }
    if (Test-Port $p) {
      $id = Get-ListenPid $p
      if ($id) { try { if ((Get-Process -Id $id -ErrorAction Stop).ProcessName -eq 'node') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } catch { } }
      else {
        # no port owner visible: the node started from this folder by us is the newest node.exe
        try { Get-Process node -ErrorAction Stop | Where-Object { $_.StartTime -ge $script:ProcStart } | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
      }
    }
    $script:LastUp = 'exited'
    Say '服务器已停止。'
  } else {
    $p = [int]$numPort.Value
    $id = Get-ListenPid $p
    if ($id) {
      $name = ''
      try { $name = (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { }
      if ($ask) {
        $r = (Show-Msg ("端口 $p 上运行的是其他方式启动的程序（$name，PID $id）。`r`n要结束它吗？") $Title 'YesNo' 'Warning')
        if ($r -ne 'Yes') { return }
      }
      Kill-Tree $id
      Say ("已结束端口 $p 上的进程（$name，PID $id）。")
    }
  }
  Start-Sleep -Milliseconds 300
  Refresh-State
}

function Run-Console([string]$title, [string]$cmdline) {
  $full = "title $title & cd /d `"$Root`" & $cmdline & echo. & echo 完成。按任意键关闭本窗口。 & pause >nul"
  Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /k `"chcp 65001 >nul & $full & exit`"" -WorkingDirectory $Root
}

function Run-Setup {
  if (-not $script:Node) { $script:Node = Find-Node }
  if (-not $script:Node) { [void](Show-Msg ('没有找到 Node.js，请先安装（winget install OpenJS.NodeJS.LTS）。') $Title 'OK' 'Warning'); return }
  $setupArgs = if ($chkNoAssets.Checked) { ' --no-assets' } else { '' }
  $cmd = "(if not exist node_modules\ws\package.json (echo 正在安装依赖 npm ci ... & call npm.cmd ci --no-audit --no-fund || call npm.cmd install --no-audit --no-fund)) & `"$($script:Node)`" tools\setup.mjs$setupArgs"
  Say '已打开「准备环境」窗口（安装依赖、下载/检查美术资源）。'
  Run-Console '准备环境' $cmd
}

function Run-Update {
  $git = Find-Git
  if (-not $git) { [void](Show-Msg ('没有找到 Git。') $Title 'OK' 'Warning'); return }
  if (-not (Test-Path (Join-Path $Root '.git'))) { [void](Show-Msg ('这个文件夹不是 Git 仓库，无法自动更新。') $Title 'OK' 'Warning'); return }
  $branch = ''; $remotes = @()
  try { $branch = (& $git -C $Root rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1).Trim() } catch { }
  try { $remotes = @(& $git -C $Root remote 2>$null) } catch { }
  if (-not $branch -or $branch -eq 'HEAD') { [void](Show-Msg ('当前不在任何分支上，请手动更新。') $Title 'OK' 'Warning'); return }
  if ($remotes -contains 'private') { $cmd = "`"$git`" fetch private && `"$git`" merge --ff-only private/$branch" }
  else { $cmd = "`"$git`" pull --ff-only" }
  $note = if (Ours-Running -or (Test-Port ([int]$numPort.Value))) { '（更新完成后请点「重启」让服务器用上新代码，浏览器按 Ctrl+F5 刷新）' } else { '' }
  Say ("已打开「更新代码」窗口：分支 $branch，只快进，不会覆盖本地修改。" + $note)
  Run-Console '更新代码' $cmd
}

$btnStart.Add_Click({ Start-Server })
$btnStop.Add_Click({ Stop-Server $true })
$btnRestart.Add_Click({ Stop-Server $false; Start-Sleep -Milliseconds 500; Start-Server })
$btnOpen.Add_Click({ Open-Web })
$btnCopy.Add_Click({
  $p = [int]$numPort.Value
  $lan = @(Get-LanAddresses)
  if (-not $lan.Count) { Say '没有检测到局域网地址。'; return }
  $t = ($lan | ForEach-Object { "http://${_}:$p" }) -join "`r`n"
  [System.Windows.Forms.Clipboard]::SetText($t)
  Say ("已复制：" + ($t -replace "`r`n", '  '))
})
$btnSetup.Add_Click({ Run-Setup })
$btnUpdate.Add_Click({ Run-Update })
$btnFolder.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$Root`"" })
$btnClear.Add_Click({ $log.Clear() })
$numPort.Add_ValueChanged({ Update-Addr })
$chkLocal.Add_CheckedChanged({ Update-Addr })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  try {
    Read-NewLog
    $script:Tick++
    if ($script:Starting -or ($script:Tick % 4) -eq 0) { Refresh-State }
  } catch { }
})

$form.Add_Shown({
  Update-Addr
  if ($script:Node) { Say ("Node.js：" + $script:Node + "  （" + ((& $script:Node -v) | Select-Object -First 1) + "）") }
  else { Say '没有找到 Node.js（需要 22 或更高版本）：winget install OpenJS.NodeJS.LTS' }
  Say ("项目目录：" + $Root)
  Refresh-State
  $timer.Start()
})
$form.Add_FormClosing({
  param($sender, $e)
  if (Ours-Running) {
    $r = (Show-Msg ("服务器还在运行。关闭启动器时要停止服务器吗？`r`n选「否」则服务器继续在后台运行（之后可以重新打开启动器来停止）。") $Title 'YesNoCancel' 'Question')
    if ($r -eq 'Cancel') { $e.Cancel = $true; return }
    if ($r -eq 'Yes') { Stop-Server $false }
  }
  $timer.Stop()
})

if ($env:SPL_TEST -eq '1') {
  # self-check without showing the window (tools / CI)
  Update-Addr; Refresh-State
  "node=$($script:Node) status=$($lblStatus.Text) addr=$($lblAddr.Text)"
  return
}
if ($env:SPL_TEST -eq '2') {
  # start → port answers → stop, without the window
  $chkOpen.Checked = $false; $numPort.Value = 3917
  Start-Server
  for ($i = 0; $i -lt 80 -and -not (Test-Port 3917); $i++) { Start-Sleep -Milliseconds 500 }
  "up=$(Test-Port 3917) ours=$(Ours-Running)"
  Start-Sleep -Milliseconds 800; Read-NewLog; Refresh-State
  "status-while-up=$($lblStatus.Text)"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Stop-Server $false
  "after-stop up=$(Test-Port 3917) ours=$(Ours-Running) ms=$($sw.ElapsedMilliseconds)"
  "log: " + (($log.Text -split "`r`n" | Where-Object { $_ } | Select-Object -First 10) -join ' | ')
  return
}
[void]$form.ShowDialog()
