<#
    Remove the desktop integration. Leaves all collected data untouched.
#>
[CmdletBinding()]
param([string]$TaskName = 'perfint-collector')

$ErrorActionPreference = 'Continue'

try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed logon task '$TaskName'."
} catch { Write-Host "No logon task named '$TaskName'." }

foreach ($dir in @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    ([Environment]::GetFolderPath('Desktop'))
)) {
    $lnk = Join-Path $dir 'Veyra Performance Intelligence.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
}

Write-Host ''
Write-Host 'Desktop integration removed. Your data in data\ was not touched.'
