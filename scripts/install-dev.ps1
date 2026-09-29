# Development only: link extension/ into the per-user CEP extensions folder
# with a directory junction, so edits are live on the next panel reload.
# Needs debug mode (scripts/enable-debug-mode.ps1). Restart Premiere once
# afterwards so it discovers the extension. Run with -Remove to unlink.
param([switch]$Remove)
$ErrorActionPreference = "Stop"

$id   = "com.scripthare.renderhare"
$src  = (Resolve-Path (Join-Path $PSScriptRoot "..\extension")).Path
$dir  = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $dir $id

if (Test-Path $dest) {
    $item = Get-Item $dest -Force
    if ($item.LinkType) { [System.IO.Directory]::Delete($dest, $false) }   # the link only
    else { throw "$dest is a real folder (an installed copy?). Remove it via your ZXP installer first." }
    Write-Host "Removed link: $dest"
}
if ($Remove) { return }

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
Write-Host "Linked $dest -> $src"
Write-Host "Restart Premiere Pro, then open Window > Extensions > Render Hare."
