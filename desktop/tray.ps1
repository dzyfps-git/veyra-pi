<#
    System tray host.

    A hidden PowerShell process owning a NotifyIcon. This is the one piece
    WebView2 cannot provide on its own, and it is what makes the app behave
    like Discord or Steam: the collector keeps running in the notification
    area whether or not a window is open.

    No third-party dependency, no compiler, no Electron. It costs roughly
    25-35 MB of working set.

    Right-click menu:
      Open            open the app window
      Pause / Resume  suspend all interaction with monitored servers
      Open data folder
      Quit            stop the tray AND the collector
#>
[CmdletBinding()]
param([switch]$NoCollector)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$launch = Join-Path $PSScriptRoot 'launch.ps1'
$iconPath = Join-Path $PSScriptRoot 'app.ico'

if (-not $NoCollector) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $launch -CollectorOnly | Out-Null
}

function Get-Port {
    try {
        $db = Join-Path $root 'data\perfint.sqlite'
        if (-not (Test-Path $db)) { return 9101 }
        $node = Join-Path $env:LOCALAPPDATA 'Zed\node\node-v24.11.0-win-x64\node.exe'
        if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
        if (-not $node) { return 9101 }
        $out = & $node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});let v=9101;try{const r=d.prepare(`"SELECT value FROM setting WHERE key='interface.port'`").get();if(r)v=JSON.parse(r.value);}catch{};console.log(v)" $db 2>$null
        if ($out) { return [int]$out }
    } catch { }
    return 9101
}

$port = Get-Port
$base = "http://127.0.0.1:$port"

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = if (Test-Path $iconPath) {
    New-Object System.Drawing.Icon $iconPath
} else {
    [System.Drawing.SystemIcons]::Information
}
$icon.Visible = $true
$icon.Text = 'Performance Intelligence'

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add('Open')
$openItem.Add_Click({
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$launch`"",'-WindowOnly') | Out-Null
})

$pauseItem = $menu.Items.Add('Pause monitoring')
$pauseItem.Add_Click({
    try {
        $paused = $pauseItem.Text -eq 'Pause monitoring'
        $body = @{ 'limits.paused' = $paused } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$base/api/settings" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 4 | Out-Null
        $pauseItem.Text = if ($paused) { 'Resume monitoring' } else { 'Pause monitoring' }
        $icon.Text = if ($paused) { 'Performance Intelligence — paused' } else { 'Performance Intelligence' }
    } catch {
        [System.Windows.Forms.MessageBox]::Show('Could not reach the collector.', 'Performance Intelligence') | Out-Null
    }
})

$folderItem = $menu.Items.Add('Open data folder')
$folderItem.Add_Click({ Start-Process explorer.exe (Join-Path $root 'data') })

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quitItem = $menu.Items.Add('Quit (stops monitoring)')
$quitItem.Add_Click({
    try { Invoke-RestMethod -Uri "$base/api/shutdown" -Method Post -TimeoutSec 4 | Out-Null } catch { }
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$icon.ContextMenuStrip = $menu
$icon.Add_DoubleClick({ $openItem.PerformClick() })

# A hidden ApplicationContext keeps the message loop alive with no window.
$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
$icon.Dispose()
