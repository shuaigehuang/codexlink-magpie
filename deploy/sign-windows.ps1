[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$resolved = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "Signature target not found: $resolved"
}

$signtoolPath = $null
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtool) {
    $signtoolPath = $signtool.Source
} else {
    $kits = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($kit in $kits) {
        $candidate = Join-Path $kit.FullName "x64\signtool.exe"
        if (Test-Path -LiteralPath $candidate) {
            $signtoolPath = (Get-Item -LiteralPath $candidate).FullName
            break
        }
    }
}

if (-not $signtoolPath) {
    if ($RequireSignature) {
        throw "signtool.exe not found. Install the Windows SDK before producing a signed release."
    }
    Write-Warning "signtool.exe not found; the installer was not signed."
    return
}

$thumbprint = [string]$env:CODEXLINK_SIGN_CERT_SHA1
$pfxPath = [string]$env:CODEXLINK_SIGN_PFX
$pfxPassword = [string]$env:CODEXLINK_SIGN_PFX_PASSWORD
$timestamp = "http://timestamp.digicert.com"

$arguments = @("sign", "/fd", "SHA256", "/td", "SHA256", "/tr", $timestamp)
if (-not [string]::IsNullOrWhiteSpace($pfxPath)) {
    if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf) -or [string]::IsNullOrWhiteSpace($pfxPassword)) {
        if ($RequireSignature) {
            throw "CODEXLINK_SIGN_PFX and CODEXLINK_SIGN_PFX_PASSWORD must point to a valid signing certificate."
        }
        Write-Warning "PFX signing is not fully configured; the installer was not signed."
        return
    }
    $arguments += @("/f", $pfxPath, "/p", $pfxPassword)
} elseif (-not [string]::IsNullOrWhiteSpace($thumbprint)) {
    $arguments += @("/sha1", $thumbprint)
} else {
    if ($RequireSignature) {
        throw "No code-signing certificate configured. Set CODEXLINK_SIGN_PFX or CODEXLINK_SIGN_CERT_SHA1."
    }
    Write-Warning "No code-signing certificate configured; the installer was not signed."
    return
}
$arguments += $resolved

& $signtoolPath @arguments
if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne "Valid") {
    throw "Authenticode verification failed: $($signature.StatusMessage)"
}
Write-Host "Signed and verified: $resolved"
