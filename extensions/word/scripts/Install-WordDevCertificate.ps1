$ErrorActionPreference = 'Stop'
$certDir = Join-Path $env:LOCALAPPDATA 'FolioWordAddin'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfxPath = Join-Path $certDir 'localhost.pfx'
$passwordPath = Join-Path $certDir 'localhost.password'
$trustedPath = Join-Path $certDir 'localhost.trusted'
$cerPath = Join-Path $certDir 'localhost.cer'
$friendlyName = 'Folio Word add-in localhost HTTPS'
$certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.FriendlyName -eq $friendlyName -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $certificate) {
  Remove-Item -LiteralPath $trustedPath -Force -ErrorAction SilentlyContinue
  $certificate = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName $friendlyName -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(2)
}

Remove-Item -LiteralPath $pfxPath,$cerPath -Force -ErrorAction SilentlyContinue
$randomBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($randomBytes)
$rng.Dispose()
$pfxPassword = [Convert]::ToBase64String($randomBytes)
$securePassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
[System.IO.File]::WriteAllText($passwordPath, $pfxPassword)

Write-Host "Created a localhost-only HTTPS certificate in $certDir."
Write-Host 'The task-pane host will remain unavailable until this certificate is trusted for the current Windows user.'
$answer = Read-Host 'Trust this certificate in CurrentUser\Root now? Type TRUST to continue'
if ($answer -ceq 'TRUST') {
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
  [System.IO.File]::WriteAllText($trustedPath, $certificate.Thumbprint)
  Write-Host 'Certificate trust installed for the current Windows user only.'
} else {
  Write-Host 'Trust was skipped. Run this script again and type TRUST when ready.'
}
