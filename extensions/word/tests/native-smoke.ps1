$ErrorActionPreference = 'Stop'
$Tests = $PSScriptRoot
$Native = Join-Path (Split-Path -Parent $Tests) 'native'
& (Join-Path $Native 'build.ps1')

$Architecture = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
$Framework = Join-Path $env:WINDIR $(if ($Architecture -eq 'x64') { 'Microsoft.NET\Framework64\v4.0.30319' } else { 'Microsoft.NET\Framework\v4.0.30319' })
$Compiler = Join-Path $Framework 'csc.exe'
$Reference = Join-Path $Framework 'System.Web.Extensions.dll'
$Output = Join-Path $env:TEMP "FolioWordNativeSmoke-$PID.exe"
$Source = Join-Path $Tests 'native-smoke.cs'
$Assembly = Join-Path $Native "win-$Architecture\Folio.WordAddin.dll"

try {
  & $Compiler /nologo /target:exe "/platform:$Architecture" "/reference:$Reference" "/out:$Output" $Source
  if ($LASTEXITCODE -ne 0) { throw "Native smoke harness compilation failed with exit code $LASTEXITCODE" }
  & $Output $Assembly
  if ($LASTEXITCODE -ne 0) { throw "Native smoke harness failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
}
