param([int]$Port = 3000, [int]$UpdateMinutes = 30, [switch]$NoUpdate)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
$repo = Split-Path -Parent $PSScriptRoot
$canUpdate = (-not $NoUpdate) -and $git -and (Test-Path -LiteralPath (Join-Path $repo '.git'))
$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found. Install Edge before starting kiosk mode.' }

# Fast-forward to the latest GitHub version; returns $true when new code arrived.
function Update-FromGitHub {
    try {
        $before = (& $git -C $repo rev-parse HEAD).Trim()
        & $git -C $repo pull --ff-only --quiet 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'git pull failed; keeping the current version.'; return $false }
        $after = (& $git -C $repo rev-parse HEAD).Trim()
        if ($before -eq $after) { return $false }
        Write-Host "Updated $($before.Substring(0,7)) -> $($after.Substring(0,7))"
        $changed = & $git -C $repo diff --name-only $before $after
        if ($changed -match '^hub/package(-lock)?\.json$') {
            Push-Location $PSScriptRoot
            try { npm ci --no-audit --no-fund | Out-Null } finally { Pop-Location }
        }
        return $true
    } catch {
        Write-Warning "Update check failed: $($_.Exception.Message)"
        return $false
    }
}

function Start-Server {
    $env:PORT = "$Port"
    $env:HOST = '127.0.0.1'
    Start-Process -FilePath $node -ArgumentList "`"$PSScriptRoot\server.mjs`"" -WorkingDirectory $PSScriptRoot -PassThru
}

function Wait-Server($proc) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($proc.HasExited) { throw 'The newspaper server exited. Check the server window for errors (the port may be in use).' }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/papers" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch [System.Net.WebException] {
            Start-Sleep -Milliseconds 250
        }
    }
    throw 'The newspaper server did not become ready.'
}

if ($canUpdate) { [void](Update-FromGitHub) }
if (-not (Test-Path -LiteralPath "$PSScriptRoot\node_modules\pdfjs-dist")) {
    Push-Location $PSScriptRoot
    try { npm ci --no-audit --no-fund } finally { Pop-Location }
}

$server = Start-Server
try {
    Wait-Server $server
    Start-Process -FilePath $edge -ArgumentList "--kiosk http://127.0.0.1:$Port/?ambient=1 --edge-kiosk-type=fullscreen --no-first-run"
    Write-Host 'Newspaper kiosk started. Alt+F4 exits Edge. Close this window (Ctrl+C) to stop the server.'
    # Keep running: poll GitHub, and restart the server on updates so open pages reload themselves.
    while ($true) {
        if ($canUpdate) {
            Start-Sleep -Seconds ($UpdateMinutes * 60)
            if (Update-FromGitHub) {
                Stop-Process -Id $server.Id
                $server = Start-Server
                Wait-Server $server
            }
        } else {
            Start-Sleep -Seconds 3600
        }
        if ($server.HasExited) { $server = Start-Server; Wait-Server $server }
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
}
