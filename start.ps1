$root = "C:\StateCore\StateCore"

Write-Host "Starting StateCore..." -ForegroundColor Cyan

# Start Docker containers if not running
$postgres = docker ps --filter "name=statecore-postgres-1" --filter "status=running" -q
$redis = docker ps --filter "name=statecore-redis-1" --filter "status=running" -q

if (-not $postgres -or -not $redis) {
    Write-Host "Starting Docker containers..." -ForegroundColor Yellow
    Set-Location $root
    docker compose up -d
    Start-Sleep 3
}

# Start API
Write-Host "Starting API (port 3002)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; pnpm dev:api" -WindowStyle Minimized

Start-Sleep 3

# Start Worker
Write-Host "Starting Worker..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; pnpm dev:worker" -WindowStyle Minimized

Start-Sleep 4

# Health check
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3002/health" -TimeoutSec 5 -UseBasicParsing
    Write-Host "StateCore ready!" -ForegroundColor Green
} catch {
    Write-Host "API not responding yet — give it a few more seconds" -ForegroundColor Yellow
}

# Open status widget
Write-Host "Opening status widget..." -ForegroundColor Cyan
Start-Process msedge --ArgumentList "--app=file:///$root/status.html", "--window-size=340,340", "--window-position=1560,20"
