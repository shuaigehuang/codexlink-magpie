param(
    [string]$Version = "1.2.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot "cloudflare"
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "codexlink-cloudflare-$Version"
$archive = Join-Path $dist "codexlink-cloudflare-$Version.zip"

if (-not (Test-Path -LiteralPath (Join-Path $source "scripts\install.mjs"))) {
    throw "Cloudflare relay source not found: $source"
}

$resolvedStage = [System.IO.Path]::GetFullPath($stage)
$resolvedDist = [System.IO.Path]::GetFullPath($dist)
if (-not $resolvedStage.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a stage directory outside dist: $resolvedStage"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path -LiteralPath $resolvedStage) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}

$excludeDirs = @("node_modules", ".wrangler", "import-data")
$excludeFiles = @(
    ".secrets.json",
    ".admin-password",
    ".install-state.json",
    "wrangler.toml",
    ".wrangler-deploy-output.ndjson",
    "*.log"
)

$robocopyArgs = @(
    $source,
    $resolvedStage,
    "/E",
    "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
    "/XD"
) + $excludeDirs + @("/XF") + $excludeFiles

& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$guide = @"
CodexLink Cloudflare Workers relay $Version
============================================

Requirements:
  - Node.js 20 or newer
  - Cloudflare account on the free plan
  - API Token with Workers Scripts:Edit and D1:Edit

Windows:
  set CLOUDFLARE_API_TOKEN=your-token
  install.cmd

Linux / macOS:
  export CLOUDFLARE_API_TOKEN="your-token"
  node scripts/install.mjs

Recommended for mainland China (workers.dev may be DNS-poisoned):
  node scripts/install.mjs --custom-domain relay.example.com

The installer creates the D1 database, applies migrations, deploys the
Worker, then prints the relay URL and admin console address.

Full documentation: README.md
"@
Set-Content -LiteralPath (Join-Path $resolvedStage "QUICKSTART.txt") -Value $guide -Encoding utf8

Compress-Archive -LiteralPath $resolvedStage -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
"$hash  codexlink-cloudflare-$Version.zip" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii

Write-Host "Created $archive"
Write-Host "SHA256 $hash"
