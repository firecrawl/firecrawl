#!/bin/bash

# Self-hosted Firecrawl deployment script
# Run this on your server after code is deployed

set -e

echo "🚀 Starting Firecrawl deployment..."

# Check if docker-compose exists
if [ ! -f "docker-compose.yaml" ]; then
    echo "❌ docker-compose.yaml not found!"
    exit 1
fi

# Stop existing services
echo "🛑 Stopping existing services..."
docker-compose down

# Pull latest images
echo "📥 Pulling latest images..."
docker-compose pull

# Build and start services
echo "🏗️ Building and starting services..."
docker-compose up -d --build

# Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 30

# Health checks
echo "🔍 Running health checks..."

# API health check
if curl -f -s http://localhost:3002/ > /dev/null; then
    echo "✅ API service is healthy"
else
    echo "❌ API service health check failed"
    exit 1
fi

# MCP service health check (if running)
if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ MCP service is healthy"
else
    echo "⚠️ MCP service not accessible (may not be running)"
fi

# Clean up
echo "🧹 Cleaning up old images..."
docker image prune -f

echo "🎉 Deployment completed successfully!"
echo ""
echo "Services running:"
echo "  - API: http://localhost:3002"
echo "  - MCP: http://localhost:3000 (if enabled)"
echo ""
echo "Check logs with: docker-compose logs -f"