.PHONY: dev build test lint docker-up docker-down clean

# Frontend and Backend parallel dev servers
dev:
	@echo "Starting backend and frontend in development mode..."
	npm run dev

# Build the complete system
build:
	@echo "Building backend and frontend..."
	npm run build

# Run linting
lint:
	@echo "Linting codebase..."
	cd frontend && npm run lint || exit 0
	cd backend && npm run lint || exit 0

# Docker commands for production or isolated environment
docker-up:
	@echo "Starting Mimir stack in Docker..."
	docker-compose up -d

docker-down:
	@echo "Stopping Mimir stack in Docker..."
	docker-compose down

# Clean build artifacts
clean:
	@echo "Cleaning dist directories..."
	rm -rf frontend/dist
	rm -rf backend/dist
