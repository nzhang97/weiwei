# Shared Node.js lookup for the Windows launchers; no machine-wide environment changes.
param([switch]$PathOnly)

function Get-NodeInfo([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $raw = & $Path --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $raw -isnot [string]) { return $null }
    $version = [version]'0.0'
    if (-not [version]::TryParse($raw.Trim().TrimStart('v'), [ref]$version)) { return $null }
    return [pscustomobject]@{ Path = $Path; Version = $version; Major = $version.Major }
  } catch { return $null }
}

$system = $null
$command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($command) { $system = Get-NodeInfo $command.Source }
$selected = $system
if (-not $system -or $system.Major -lt 22) {
  $runtime = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'
  $portable = Get-ChildItem -LiteralPath $runtime -Directory -Filter 'node-v*-win-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-NodeInfo (Join-Path $_.FullName 'node.exe') } |
    Where-Object { $_.Major -ge 22 } |
    Sort-Object -Property @{ Expression = { $_.Version }; Descending = $true }, Path |
    Select-Object -First 1
  if ($portable) { $selected = $portable }
}

if ($PathOnly) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  if ($selected) { $selected.Path }
} else {
  $selected
}
