$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BuildRoot = Join-Path $ProjectRoot 'backend\build'
$TempRoot = Join-Path $BuildRoot 'tmp'
$env:PIP_CACHE_DIR = Join-Path $ProjectRoot '.cache\pip'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $ProjectRoot '.cache\pyinstaller'
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:TMPDIR = $TempRoot
New-Item -ItemType Directory -Force -Path $BuildRoot, $TempRoot, (Join-Path $ProjectRoot 'backend\dist'), $env:PIP_CACHE_DIR, $env:PYINSTALLER_CONFIG_DIR | Out-Null
$PyInstaller = Join-Path $ProjectRoot '.venv\Scripts\pyinstaller.exe'
if (-not (Test-Path -LiteralPath $PyInstaller)) { throw 'PyInstaller is missing from the project virtual environment.' }
$Arguments = @(
  '--noconfirm', '--clean', '--onefile', '--name', 'workbench-service',
  '--distpath', (Join-Path $ProjectRoot 'backend\dist'),
  '--workpath', $BuildRoot, '--specpath', $BuildRoot, '--paths', $ProjectRoot,
  '--collect-submodules', 'keyring.backends', '--hidden-import', 'keyring.backends.Windows',
  '--hidden-import', 'win32ctypes.pywin32', 'backend\entrypoint.py'
)
Push-Location $ProjectRoot
try {
  & $PyInstaller @Arguments
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }
  $Executable = Join-Path $ProjectRoot 'backend\dist\workbench-service.exe'
  if (-not (Test-Path -LiteralPath $Executable)) { throw 'Backend executable was not created.' }
  Write-Output "Built backend: $Executable"
} finally {
  Pop-Location
}
