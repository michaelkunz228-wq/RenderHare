# Development only: let Premiere load unsigned CEP extensions (CEP 12/13).
# Release builds are signed .zxp files and don't need this. No admin rights
# needed (writes to HKCU). Restart Premiere afterwards.
$ErrorActionPreference = "Stop"
foreach ($v in 12..13) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
    Write-Host "CSXS.$v PlayerDebugMode = 1"
}
Write-Host "Done. Fully quit and reopen Premiere Pro."
