# Background monitor - runs at logon, detects wake events, restores Docker network
$host.UI.RawUI.WindowTitle = "StateCore-WakeMonitor"

$apiUrl = "http://127.0.0.1:3002/health"
$lastOk = $true

function Test-Api {
    try {
        $r = Invoke-WebRequest -Uri $apiUrl -TimeoutSec 3 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Repair-Network {
    # Step 1: restart containers (fixes Docker port-forwarding proxy after WSL wake)
    docker restart statecore-api-1 statecore-worker-1 2>$null
    Start-Sleep -Seconds 8
    if (Test-Api) { return }

    # Step 2: reset WSL2 network, then restart containers
    wsl --shutdown 2>$null
    Start-Sleep -Seconds 10
    docker restart statecore-api-1 statecore-worker-1 2>$null
    Start-Sleep -Seconds 8
    if (Test-Api) { return }

    # Step 3: restart Docker Desktop
    Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
}

while ($true) {
    Start-Sleep -Seconds 15
    $ok = Test-Api
    if (-not $ok -and $lastOk) {
        # Transition OK→fail: likely just woke from sleep, give system time to settle
        Start-Sleep -Seconds 8
        if (-not (Test-Api)) {
            Repair-Network
        }
    }
    $lastOk = $ok
}
