param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root "environment.ps1")

$mobileDir = Join-Path $root "apps\mobile"
$flutter = Join-Path $root ".toolchains\flutter\bin\flutter.bat"
if (-not (Test-Path -LiteralPath $flutter)) {
    throw "未找到项目内 Flutter：$flutter"
}

Push-Location $mobileDir
try {
    & $flutter pub get
    if ($LASTEXITCODE -ne 0) { throw "flutter pub get 失败" }

    if (-not $SkipTests) {
        & $flutter analyze
        if ($LASTEXITCODE -ne 0) { throw "flutter analyze 失败" }
        & $flutter test
        if ($LASTEXITCODE -ne 0) { throw "flutter test 失败" }
    }

    & $flutter build apk --release
    if ($LASTEXITCODE -ne 0) { throw "flutter build apk 失败" }
} finally {
    Pop-Location
}

$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$apk = Join-Path $mobileDir "build\app\outputs\flutter-apk\app-release.apk"
$destination = Join-Path $dist "codexlink-mobile.apk"
Copy-Item -LiteralPath $apk -Destination $destination -Force
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
"$hash  codexlink-mobile.apk" | Set-Content -LiteralPath "$destination.sha256" -Encoding ascii

Write-Host "手机安装包已生成：$destination"
Write-Host "SHA256: $hash"
