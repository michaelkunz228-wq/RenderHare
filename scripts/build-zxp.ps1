# Package and sign Render Hare as dist/RenderHare-<version>.zxp.
#
# Needs Adobe's ZXPSignCmd (https://github.com/Adobe-CEP/CEP-Resources, folder
# ZXPSignCMD) at scripts/ZXPSignCmd.exe or passed with -ZxpSignCmd.
# Signing uses a self-signed certificate (fine for CEP): created on first run
# at cert/renderhare.p12, valid 10 years. Keep that file and its password —
# later updates should be signed with the same certificate. Both are git-ignored.
#
# No timestamp by default: ZXPSignCmd 4.1.103 crashes (access violation) with
# every timestamp server tried (DigiCert, Sectigo, GlobalSign), so signatures
# are valid for the certificate's lifetime. Pass -TimestampUrl to try one.
#
# Bump ExtensionBundleVersion (and the Extension Version) in the manifest for
# every release: Adobe's installer (UPIA) reports success but silently keeps
# the old files when the version number hasn't changed.
#
#   $env:RENDERHARE_CERT_PASSWORD = "<password>"; .\scripts\build-zxp.ps1
#   (without it, the password is read from cert/certificate-password.txt)
param(
    [string]$ZxpSignCmd = (Join-Path $PSScriptRoot "ZXPSignCmd.exe"),
    [string]$CertPath = (Join-Path $PSScriptRoot "..\cert\renderhare.p12"),
    [string]$CertPassword = $env:RENDERHARE_CERT_PASSWORD,
    [string]$TimestampUrl = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Test-Path $ZxpSignCmd)) { throw "ZXPSignCmd not found at $ZxpSignCmd (see the header of this script)." }
if (-not $CertPassword) {
    # Fall back to the password file the first build wrote next to the certificate.
    $pwFile = Join-Path (Split-Path $CertPath) "certificate-password.txt"
    if (Test-Path $pwFile) { $CertPassword = (Get-Content $pwFile | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim() }
}
if (-not $CertPassword) { throw "Set `$env:RENDERHARE_CERT_PASSWORD (the certificate password) first." }

# Version from the manifest.
[xml]$manifest = Get-Content (Join-Path $root "extension\CSXS\manifest.xml")
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
Write-Host "Render Hare $version"

# Stage extension/ without development files.
$dist  = Join-Path $root "dist"
$stage = Join-Path $dist "stage\RenderHare"
if (Test-Path (Join-Path $dist "stage")) { Remove-Item (Join-Path $dist "stage") -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $root "extension\*") $stage -Recurse -Force
Remove-Item (Join-Path $stage ".debug") -Force -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Force -Include ".DS_Store", "Thumbs.db" | Remove-Item -Force

# Certificate (self-signed, 10 years) on first run.
if (-not (Test-Path $CertPath)) {
    New-Item -ItemType Directory -Path (Split-Path $CertPath) -Force | Out-Null
    # (No -locality: ZXPSignCmd 4.1.103 writes it into the OU field instead.)
    & $ZxpSignCmd -selfSignedCert US Ohio ScriptHare "Render Hare" $CertPassword $CertPath -validityDays 3650
    if ($LASTEXITCODE -ne 0) { throw "Creating the certificate failed." }
    Write-Host "Created certificate: $CertPath  (back it up, with its password)"
}

# Sign.
$zxp = Join-Path $dist "RenderHare-$version.zxp"
if (Test-Path $zxp) { Remove-Item $zxp -Force }
$signArgs = @("-sign", $stage, $zxp, $CertPath, $CertPassword)
if ($TimestampUrl) { $signArgs += @("-tsa", $TimestampUrl) }
& $ZxpSignCmd @signArgs
if ($LASTEXITCODE -ne 0) { throw "Signing failed (exit $LASTEXITCODE)." }

& $ZxpSignCmd -verify $zxp
if ($LASTEXITCODE -ne 0) { throw "The signed package didn't verify." }

Remove-Item (Join-Path $dist "stage") -Recurse -Force
Write-Host "Built $zxp"
