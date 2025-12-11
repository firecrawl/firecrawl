.PHONY: help build test run clean docker-build docker-run docker-stop install lint fmt

# Default target
help:
	@echo "HTML to Markdown Service - Available targets:"
	@echo "  make build        - Build the service binary"
	@echo "  make test         - Run tests"
	@echo "  make test-cover   - Run tests with coverage"
	@echo "  make run          - Run the service locally"
	@echo "  make clean        - Clean build artifacts"
	@echo "  make install      - Install dependencies"
	@echo "  make lint         - Run linter"
	@echo "  make fmt          - Format code"
	@echo "  make docker-build - Build Docker image"
	@echo "  make docker-run   - Run with Docker Compose"
	@echo "  make docker-stop  - Stop Docker containers"
	@echo "  make docker-logs  - View Docker logs"

# Build the service
build:
	@echo "Building service..."
	go build -o html-to-markdown-service .

# Run tests
test:
	@echo "Running tests..."
	go test -v ./...

# Run tests with coverage
test-cover:
	@echo "Running tests with coverage..."
	go test -v -cover -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Run the service
run:
	@echo "Starting service..."
	go run .

# Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -f html-to-markdown-service
	rm -f coverage.out coverage.html
	go clean

# Install dependencies
install:
	@echo "Installing dependencies..."
	go mod download
	go mod tidy

# Run linter (requires golangci-lint)
lint:
	@echo "Running linter..."
	golangci-lint run

# Format code
fmt:
	@echo "Formatting code..."
	go fmt ./...

# Build Docker image
docker-build:
	@echo "Building Docker image..."
	docker build -t html-to-markdown-service:latest .

# Run with Docker Compose
docker-run:
	@echo "Starting with Docker Compose..."
	docker-compose up -d

# Stop Docker containers
docker-stop:
	@echo "Stopping Docker containers..."
	docker-compose down

# View Docker logs
docker-logs:
	@echo "Viewing Docker logs..."
	docker-compose logs -f

# Run all checks before commit
pre-commit: fmt lint test
	@echo "Pre-commit checks passed!"

