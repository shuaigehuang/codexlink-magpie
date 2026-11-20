$ErrorActionPreference = "Stop"

$CodexLinkRoot = $PSScriptRoot
$CodexLinkToolchains = Join-Path $CodexLinkRoot ".toolchains"
$CodexLinkEnvRoot = Join-Path $CodexLinkRoot "environment"

$requiredDirs = @(
    $CodexLinkEnvRoot,
    (Join-Path $CodexLinkEnvRoot "android"),
    (Join-Path $CodexLinkEnvRoot "gradle"),
    (Join-Path $CodexLinkEnvRoot "go"),
    (Join-Path $CodexLinkEnvRoot "go\build-cache"),
    (Join-Path $CodexLinkEnvRoot "npm-cache"),
    (Join-Path $CodexLinkEnvRoot "ssh"),
    (Join-Path $CodexLinkEnvRoot "tmp")
)
foreach ($dir in $requiredDirs) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$jdk = Get-ChildItem -LiteralPath (Join-Path $CodexLinkToolchains "jdk") -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
$node = Get-ChildItem -LiteralPath $CodexLinkToolchains -Directory -Filter "node-*-win-x64" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1

$env:CODEXLINK_ENV_ROOT = $CodexLinkEnvRoot
$env:GRADLE_USER_HOME = Join-Path $CodexLinkEnvRoot "gradle"
$env:GOPATH = Join-Path $CodexLinkEnvRoot "go"
$env:GOMODCACHE = Join-Path $env:GOPATH "pkg\mod"
$env:GOCACHE = Join-Path $CodexLinkEnvRoot "go\build-cache"
$env:GOENV = Join-Path $CodexLinkEnvRoot "go\env"
$env:PUB_CACHE = Join-Path $CodexLinkToolchains "pub-cache"
$env:npm_config_cache = Join-Path $CodexLinkEnvRoot "npm-cache"
$env:TEMP = Join-Path $CodexLinkEnvRoot "tmp"
$env:TMP = $env:TEMP

$env:ANDROID_HOME = Join-Path $CodexLinkToolchains "android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if ($jdk) {
    $env:JAVA_HOME = $jdk.FullName
}

$env:CODEXLINK_ANDROID_STORE_FILE = Join-Path $CodexLinkEnvRoot "android\debug.keystore"
$env:CODEXLINK_ANDROID_STORE_PASSWORD = "android"
$env:CODEXLINK_ANDROID_KEY_ALIAS = "androiddebugkey"
$env:CODEXLINK_ANDROID_KEY_PASSWORD = "android"

$pathParts = @(
    (Join-Path $env:GOPATH "bin"),
    (Join-Path $CodexLinkToolchains "go\bin"),
    (Join-Path $CodexLinkToolchains "gobin"),
    (Join-Path $CodexLinkToolchains "flutter\bin"),
    (Join-Path $CodexLinkToolchains "mingit\cmd"),
    (Join-Path $CodexLinkToolchains "cmake\bin"),
    (Join-Path $env:ANDROID_HOME "platform-tools"),
    (Join-Path $env:JAVA_HOME "bin"),
    $node.FullName
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$env:PATH = (($pathParts + $env:PATH) -join ";")
