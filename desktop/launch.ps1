<#
    Desktop launcher.

    Deliberately thin: it contains no application logic. Its only jobs are to
    make sure the background collector is alive and to open a window onto it.
    That is what keeps the door open to swapping this shell for Electron (or
    anything else) later without touching a line of the application -- the
    collector is already a standalone process speaking HTTP on loopback, and
    the shell is a pure client.

    Usage:
      launch.ps1                 start collector if needed, open the window
      launch.ps1 -CollectorOnly  start the collector only (used by the logon task)
      launch.ps1 -WindowOnly     open the window only
#>
[CmdletBinding()]
param(
    [switch]$CollectorOnly,
    [switch]$WindowOnly,
    [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $env:LOCALAPPDATA 'Zed\node\node-v24.11.0-win-x64\node.exe'
if (-not (Test-Path $nodeExe)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source } else { throw 'Node.js was not found. Install Node LTS and try again.' }
}

function Get-Endpoint {
    # The port is a setting, so read it from the database rather than assuming.
    $default = @{ Host = '127.0.0.1'; Port = 9101 }
    $db = Join-Path $root 'data\perfint.sqlite'
    if (-not (Test-Path $db)) { return $default }
    try {
        $script = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const get = (k, d) => {
  try { const r = db.prepare('SELECT value FROM setting WHERE key = ?').get(k); return r ? JSON.parse(r.value) : d; }
  catch { return d; }
};
console.log(JSON.stringify({ Host: get('interface.host', '127.0.0.1'), Port: get('interface.port', 9101) }));
'@
        $out = & $nodeExe -e $script $db 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ($out | ConvertFrom-Json) }
    } catch { }
    return $default
}

function Test-Collector([string]$Address, [int]$Port) {
    try {
        $r = Invoke-WebRequest -Uri "http://${Address}:${Port}/api/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Start-Collector([string]$Address, [int]$Port) {
    if (Test-Collector $Address $Port) { return $true }

    # Hidden: no console window should ever appear for a background service.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$(Join-Path $root 'src\cli\collector.ts')`""
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [void][System.Diagnostics.Process]::Start($psi)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-Collector $Address $Port) { return $true }
    }
    return $false
}

function Open-Window([string]$Address, [int]$Port) {
    $url = "http://${Address}:${Port}/"
    # App mode gives a chromeless window with its own taskbar entry, using the
    # WebView2/Edge runtime already present on Windows 11. A dedicated profile
    # directory keeps it isolated from the user's browsing session.
    $profileDir = Join-Path $env:LOCALAPPDATA 'perfint\window-profile'
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

    $edge = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($edge) {
        Start-Process $edge -ArgumentList @(
            "--app=$url",
            "--user-data-dir=`"$profileDir`"",
            '--window-size=1440,960',
            '--no-first-run',
            '--no-default-browser-check'
        )
    } else {
        Start-Process $url
    }
}

$endpoint = Get-Endpoint
$address = $endpoint.Host
$port = [int]$endpoint.Port

if (-not $WindowOnly) {
    if (-not (Start-Collector $address $port)) {
        if (-not $CollectorOnly) {
            [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
            [System.Windows.Forms.MessageBox]::Show(
                "The background collector did not start within $TimeoutSeconds seconds.`n`nCheck data\logs for details.",
                'Performance Intelligence', 'OK', 'Error') | Out-Null
        }
        exit 1
    }
}

if (-not $CollectorOnly) { Open-Window $address $port }
