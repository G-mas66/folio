param([ValidateSet('nsis', 'portable')][string]$Target = 'nsis')
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AppPackage = Get-Content -Raw (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$AppVersion = $AppPackage.version
$CacheRoot = Join-Path $ProjectRoot '.cache'
$env:npm_config_cache = Join-Path $CacheRoot 'npm'
$env:ELECTRON_CACHE = Join-Path $CacheRoot 'electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $CacheRoot 'electron-builder'
$env:TEMP = Join-Path $CacheRoot 'build-temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:npm_config_cache, $env:ELECTRON_CACHE, $env:ELECTRON_BUILDER_CACHE, $env:TEMP | Out-Null
Push-Location $ProjectRoot
try {
  npm run build:ui
  if ($LASTEXITCODE -ne 0) { throw "UI build failed with exit code $LASTEXITCODE" }
  npm run build:backend
  if ($LASTEXITCODE -ne 0) { throw "Backend build failed with exit code $LASTEXITCODE" }
  npm run build:pdf-engine
  if ($LASTEXITCODE -ne 0) { throw "PDF engine build failed with exit code $LASTEXITCODE" }
  node node_modules/electron-builder/cli.js --win $Target --publish never --config.electronDist=node_modules/electron/dist --config.directories.output="dist/installer-$AppVersion"
  if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
