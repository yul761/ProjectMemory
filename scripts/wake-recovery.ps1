# Runs on system wake - restores Docker/WSL2 network if needed
Start-Sleep -Seconds 6

$apiUrl = "http://127.0.0.1:3002/health"

function Test-Api {
    try {
        $r = Invoke-WebRequest -Uri $apiUrl -TimeoutSec 4 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (Test-Api) { exit 0 }

# Network not recovered - reset WSL2
wsl --shutdown
Start-Sleep -Seconds 10

# Wait up to 60s for Docker to reconnect
$attempts = 0
while ($attempts -lt 12) {
    if (Test-Api) { exit 0 }
    Start-Sleep -Seconds 5
    $attempts++
}

# Still down - restart Docker Desktop as last resort
Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
