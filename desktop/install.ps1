<#
    Install the desktop experience.

    Creates:
      - a Start Menu + Desktop shortcut that opens the app window
      - a hidden logon task that starts the background collector

    Everything here is per-user and reversible with uninstall.ps1. Nothing
    touches the Minecraft server, and no elevation is required.
#>
[CmdletBinding()]
param(
    [switch]$NoLogonTask,
    [switch]$NoShortcuts,
    [string]$TaskName = 'perfint-collector'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$launch = Join-Path $here 'launch.ps1'
$tray = Join-Path $here 'tray.ps1'
$icon = Join-Path $here 'app.ico'

function New-Shortcut([string]$Path, [string]$Arguments, [string]$Description) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath = (Get-Command powershell.exe).Source
    $sc.Arguments = $Arguments
    $sc.WorkingDirectory = $root
    $sc.Description = $Description
    $sc.WindowStyle = 7   # minimised: the PowerShell host must never flash
    if (Test-Path $icon) { $sc.IconLocation = $icon }
    $sc.Save()
}

if (-not $NoShortcuts) {
    $args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launch`""
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    New-Shortcut (Join-Path $startMenu 'Veyra Performance Intelligence.lnk') $args 'Open Veyra Performance Intelligence'
    New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Veyra Performance Intelligence.lnk') $args 'Open Veyra Performance Intelligence'
    Write-Host 'Shortcuts created (Start Menu and Desktop).'
}

if (-not $NoLogonTask) {
    # The tray host starts the collector, so one task covers both. Hidden, and
    # it must not be stopped just because the machine goes on battery or idles.
    $action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tray`"" `
        -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Logon task '$TaskName' registered (hidden, restarts on failure)."
}

Write-Host ''
Write-Host 'Done. Monitoring will start automatically at login.'
Write-Host 'Both behaviours are configurable in Settings -> Interface.'
