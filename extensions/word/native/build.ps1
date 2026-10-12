$ErrorActionPreference = 'Stop'
$NativeRoot = $PSScriptRoot
$Source = Join-Path $NativeRoot 'FolioWordAddin.cs'
$Framework64 = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Framework32 = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $Source)) { throw "Missing native add-in source: $Source" }
if (-not (Test-Path -LiteralPath $Framework64)) { throw "Missing .NET Framework compiler: $Framework64" }
if (-not (Test-Path -LiteralPath $Framework32)) { throw "Missing .NET Framework compiler: $Framework32" }

foreach ($Target in @(@{ Name = 'win-x64'; Compiler = $Framework64; Platform = 'x64' }, @{ Name = 'win-x86'; Compiler = $Framework32; Platform = 'x86' })) {
  $ReferenceDirectory = Split-Path -Parent $Target.Compiler
  $References = @('Microsoft.CSharp.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Xml.dll') |
    ForEach-Object { Join-Path $ReferenceDirectory $_ }
  foreach ($Reference in $References) { if (-not (Test-Path -LiteralPath $Reference)) { throw "Missing framework reference: $Reference" } }
  $OutputDirectory = Join-Path $NativeRoot $Target.Name
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $Output = Join-Path $OutputDirectory 'Folio.WordAddin.dll'
  $CompilerArguments = @('/nologo', '/target:library', "/platform:$($Target.Platform)", '/optimize+', '/langversion:5', "/out:$Output")
  foreach ($Reference in $References) { $CompilerArguments += "/reference:$Reference" }
  $CompilerArguments += $Source
  & $Target.Compiler @CompilerArguments
  if ($LASTEXITCODE -ne 0) { throw "Word native add-in compile failed for $($Target.Platform) with exit code $LASTEXITCODE" }
  Write-Output "Built $Output"
}
