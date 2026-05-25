SHELL := powershell.exe
.SHELLFLAGS := -NoProfile -NonInteractive -Command

COMPOSE_FILE := docker-compose.local.yml

.DEFAULT_GOAL := start

.PHONY: start stop build rebuild logs logs-api logs-worker restart status clean help

start:
	powershell -ExecutionPolicy Bypass -File start.ps1

stop:
	docker compose -f $(COMPOSE_FILE) down

build:
	docker compose -f $(COMPOSE_FILE) build

rebuild:
	docker compose -f $(COMPOSE_FILE) build --no-cache

logs:
	docker compose -f $(COMPOSE_FILE) logs -f

logs-api:
	docker compose -f $(COMPOSE_FILE) logs -f api

logs-worker:
	docker compose -f $(COMPOSE_FILE) logs -f worker

restart:
	docker compose -f $(COMPOSE_FILE) restart

status:
	docker compose -f $(COMPOSE_FILE) ps

clean:
	docker compose -f $(COMPOSE_FILE) down -v

help:
	@Write-Host ""
	@Write-Host "StateCore" -ForegroundColor Cyan
	@Write-Host ""
	@Write-Host "  make start        start all services (builds on first run)"
	@Write-Host "  make stop         stop all services"
	@Write-Host "  make build        build Docker images"
	@Write-Host "  make rebuild      rebuild from scratch (no cache)"
	@Write-Host "  make logs         follow all logs (Ctrl+C to exit)"
	@Write-Host "  make logs-api     follow API logs only"
	@Write-Host "  make logs-worker  follow worker logs only"
	@Write-Host "  make restart      restart running services"
	@Write-Host "  make status       show service status"
	@Write-Host "  make clean        stop and delete all data (irreversible)"
	@Write-Host ""
