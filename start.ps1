$root = "C:\StateCore\StateCore"
$compose = "docker-compose.local.yml"

Write-Host "Starting StateCore..." -ForegroundColor Cyan
Set-Location $root

# Build images if they don't exist yet
$apiImageId = docker images "statecore-api" -q 2>$null
if (-not $apiImageId) {
    Write-Host "First run - building Docker images (3-5 min)..." -ForegroundColor Yellow
    docker compose -f $compose build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed. Check output above." -ForegroundColor Red
        exit 1
    }
}

# Start all services (fast if already built)
Write-Host "Starting services..." -ForegroundColor Yellow
docker compose -f $compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to start services." -ForegroundColor Red
    exit 1
}

# Wait for API health check
Write-Host "Waiting for API..." -ForegroundColor Yellow
$maxAttempts = 30
$attempt = 0
$ready = $false
do {
    Start-Sleep 2
    $attempt++
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:3002/health" -TimeoutSec 3 -UseBasicParsing
        $ready = $true
        break
    } catch {}
} while ($attempt -lt $maxAttempts)

if (-not $ready) {
    Write-Host "API not responding after 60s - check logs:" -ForegroundColor Red
    Write-Host "  docker compose -f $compose logs api" -ForegroundColor White
    exit 1
}

Write-Host "StateCore ready!" -ForegroundColor Green

# Open status widget as floating window
Write-Host "Opening status widget..." -ForegroundColor Cyan
Start-Process msedge -ArgumentList "--app=file:///$root/status.html", "--window-size=340,340", "--window-position=1560,20"
