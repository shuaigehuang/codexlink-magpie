[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$desktopDir = Join-Path $root "apps\desktop\CodexLink"
$infoPath = Join-Path $desktopDir "build\windows\info.json"
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
$version = [string]$info.fixed.product_version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "无法从 build/windows/info.json 读取产品版本。"
}

$nsisDir = @(
    "C:\Program Files (x86)\NSIS",
    "C:\Program Files\NSIS"
) | Where-Object { Test-Path (Join-Path $_ "makensis.exe") } | Select-Object -First 1
if (-not $nsisDir) {
    throw "未找到 NSIS。请先安装 NSIS 3.x：winget install --id NSIS.NSIS --exact"
}

$nodeDir = "C:\Program Files\nodejs"
if (-not (Test-Path (Join-Path $nodeDir "npm.cmd"))) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw "未找到 Node.js/npm。请先安装 Node.js 22+。"
    }
    $nodeDir = Split-Path -Parent $nodeCommand.Source
}

$wailsCommand = Get-Command wails3 -ErrorAction SilentlyContinue
if (-not $wailsCommand) {
    throw "未找到 wails3。请运行：go install github.com/wailsapp/wails/v3/cmd/wails3@latest"
}

$env:PATH = "$nsisDir;$nodeDir;$env:PATH"

Push-Location $desktopDir
try {
    & $wailsCommand.Source task windows:package INSTALL_SCOPE=machine
    if ($LASTEXITCODE -ne 0) {
        throw "Wails Windows 安装包构建失败，退出码：$LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$builtInstaller = Join-Path $desktopDir "bin\CodexLink-amd64-installer.exe"
if (-not (Test-Path -LiteralPath $builtInstaller)) {
    throw "安装包构建完成，但没有找到输出文件：$builtInstaller"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $root "dist"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir = Join-Path $root $OutputDir
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$destination = Join-Path $OutputDir "CodexLink-Setup-$version.exe"
Copy-Item -LiteralPath $builtInstaller -Destination $destination -Force
$signScript = Join-Path $PSScriptRoot "sign-windows.ps1"
$requireSignature = $env:CODEXLINK_REQUIRE_SIGNATURE -eq "1"
& $signScript -Path $destination -RequireSignature:$requireSignature
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash

Write-Host ""
Write-Host "Windows 安装包已生成："
Write-Host "  $destination"
Write-Host "  SHA256: $hash"
