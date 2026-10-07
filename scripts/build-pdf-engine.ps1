$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CacheRoot = Join-Path $ProjectRoot '.cache'
$TempRoot = Join-Path $CacheRoot 'pdf-engine-build-temp'
$env:PIP_CACHE_DIR = Join-Path $CacheRoot 'pip'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $CacheRoot 'pyinstaller-pdf-engine'
$env:WORKBENCH_PDF_ENGINE_BUILD_HOME = Join-Path $CacheRoot 'pdf-engine-freeze-home'
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:TMPDIR = $TempRoot
New-Item -ItemType Directory -Force -Path $TempRoot, $env:PIP_CACHE_DIR, $env:PYINSTALLER_CONFIG_DIR, $env:WORKBENCH_PDF_ENGINE_BUILD_HOME, (Join-Path $ProjectRoot 'backend\dist') | Out-Null
$Python = Join-Path $ProjectRoot '.venv-pdf-engine\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) {
  py -3.12 -m venv (Join-Path $ProjectRoot '.venv-pdf-engine')
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python 3.12 PDF engine environment.' }
}
& $Python -m pip install --quiet --disable-pip-version-check 'pdf2zh-next==2.9.0' 'babeldoc==0.6.2' 'pyinstaller==6.16.0'
if ($LASTEXITCODE -ne 0) { throw "PDF engine dependency installation failed with exit code $LASTEXITCODE" }
$BuildSiteCustomize = Join-Path $ProjectRoot '.venv-pdf-engine\Lib\site-packages\sitecustomize.py'
$BuildSiteCustomizeContent = @'
import os
from pathlib import Path

build_home = os.environ.get("WORKBENCH_PDF_ENGINE_BUILD_HOME")
if build_home:
    resolved_home = Path(build_home).resolve()
    Path.home = classmethod(lambda cls: resolved_home)
'@
if (-not (Test-Path -LiteralPath $BuildSiteCustomize) -or ((Get-Content -LiteralPath $BuildSiteCustomize -Raw).TrimEnd() -ne $BuildSiteCustomizeContent.TrimEnd())) {
  Set-Content -LiteralPath $BuildSiteCustomize -Value $BuildSiteCustomizeContent -Encoding ascii
}
$ActualBuildHomeHex = (& $Python -I -c 'from pathlib import Path; print(str(Path.home()).encode().hex())').Trim()
$ExpectedBuildHomeHex = ([System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes((Resolve-Path $env:WORKBENCH_PDF_ENGINE_BUILD_HOME).Path)) -replace '-', '').ToLowerInvariant()
if ($ActualBuildHomeHex -ne $ExpectedBuildHomeHex) { throw 'Build Python cache home escaped the D workspace.' }
$SitePackages = Join-Path $ProjectRoot '.venv-pdf-engine\Lib\site-packages'
$RuntimeBinaryArguments = @()
foreach ($LibraryFolder in @('hyperscan.libs', 'levenshtein.libs', 'ml_dtypes.libs', 'numpy.libs', 'onnx.libs', 'pandas.libs', 'rapidfuzz.libs', 'scipy.libs')) {
  $LibraryPath = Join-Path $SitePackages $LibraryFolder
  if (-not (Test-Path -LiteralPath $LibraryPath)) { throw "Required runtime library folder is missing: $LibraryFolder" }
  foreach ($Dll in Get-ChildItem -LiteralPath $LibraryPath -File -Filter '*.dll') {
    $RuntimeBinaryArguments += @('--add-binary', "$($Dll.FullName);$LibraryFolder")
  }
}
$SourceRoot = Join-Path $ProjectRoot 'backend\pdf-engine-source'
$Pdf2zhSource = Join-Path $SourceRoot 'pdf2zh_next'
$BabeldocSource = Join-Path $SourceRoot 'babeldoc'
New-Item -ItemType Directory -Force -Path $Pdf2zhSource, $BabeldocSource | Out-Null
Copy-Item -Path (Join-Path $SitePackages 'pdf2zh_next\*') -Destination $Pdf2zhSource -Recurse -Force
Copy-Item -Path (Join-Path $SitePackages 'babeldoc\*') -Destination $BabeldocSource -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SitePackages 'pdf2zh_next-2.9.0.dist-info\licenses\LICENSE') -Destination (Join-Path $SourceRoot 'pdf2zh-next-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $SitePackages 'babeldoc-0.6.2.dist-info\licenses\LICENSE') -Destination (Join-Path $SourceRoot 'babeldoc-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'backend\pdf_engine\entrypoint.py') -Destination (Join-Path $SourceRoot 'workbench-pdf-engine-entrypoint.py') -Force
$SourceNotice = @'
PDF translation helper source bundle

pdf2zh-next 2.9.0 (GNU AGPL v3.0): ./pdf2zh_next and pdf2zh-next-LICENSE.txt
BabelDOC 0.6.2 (GNU AGPL v3.0): ./babeldoc and babeldoc-LICENSE.txt
The workbench integration entry point is workbench-pdf-engine-entrypoint.py.
'@
Set-Content -LiteralPath (Join-Path $SourceRoot 'README.txt') -Value $SourceNotice -Encoding utf8
$Arguments = @(
  '--noconfirm', '--onedir', '--console', '--name', 'workbench-pdf-engine',
  '--distpath', (Join-Path $ProjectRoot 'backend\dist'),
  '--workpath', (Join-Path $ProjectRoot 'backend\build-pdf-engine'),
  '--specpath', (Join-Path $ProjectRoot 'backend\build-pdf-engine')
)
$Arguments += $RuntimeBinaryArguments
$Arguments += @(
  '--collect-all', 'pdf2zh_next', '--collect-all', 'babeldoc', '--collect-all', 'tiktoken', '--collect-all', 'bitstring',
  '--hidden-import', 'tiktoken_ext.openai_public',
  '--hidden-import', 'scipy._external.array_api_compat.numpy.fft',
  (Join-Path $ProjectRoot 'backend\pdf_engine\entrypoint.py')
)
Push-Location $ProjectRoot
try {
  & $Python (Join-Path $ProjectRoot 'scripts\freeze-pdf-engine.py') @Arguments
  if ($LASTEXITCODE -ne 0) { throw "PDF engine freeze failed with exit code $LASTEXITCODE" }
  $Executable = Join-Path $ProjectRoot 'backend\dist\workbench-pdf-engine\workbench-pdf-engine.exe'
  if (-not (Test-Path -LiteralPath $Executable)) { throw 'PDF engine helper was not created.' }
  Write-Output "Built PDF engine: $Executable"
} finally {
  Pop-Location
}
