# Deployment Guide

This guide covers deploying Firecrawl with Valkey in various environments.

## Table of Contents

- [Docker Compose (Local/Development)](#docker-compose)
- [Docker Compose (Production)](#docker-compose-production)
- [Kubernetes](#kubernetes)
- [Self-Hosted Valkey](#self-hosted-valkey)

---

## Docker Compose

### Development Setup

The simplest way to run Firecrawl with Valkey locally:

```bash
# From Firecrawl root directory
docker compose up -d
```

The default `docker-compose.yaml` already uses Valkey:

```yaml
redis:
  image: valkey/valkey:alpine
  networks:
    - backend
  command: redis-server --bind 0.0.0.0
```

### Verify Valkey is Running

```bash
# Check container status
docker compose ps

# Test Valkey connection
docker compose exec redis redis-cli ping
# Expected: PONG

# Check Valkey version
docker compose exec redis redis-cli info server | grep valkey_version
```

---

## Docker Compose Production

For production deployments, use a dedicated compose file with persistence and security:

### `deploy/docker-compose.valkey.yaml`

```yaml
name: firecrawl-valkey-prod

services:
  valkey:
    image: valkey/valkey:7-alpine
    restart: unless-stopped
    command: >
      valkey-server
      --bind 0.0.0.0
      --requirepass ${VALKEY_PASSWORD:-changeme}
      --appendonly yes
      --appendfsync everysec
      --maxmemory 2gb
      --maxmemory-policy allkeys-lru
    volumes:
      - valkey-data:/data
    networks:
      - backend
    healthcheck:
      test: ["CMD", "valkey-cli", "-a", "${VALKEY_PASSWORD:-changeme}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 2.5G
        reservations:
          memory: 1G

  api:
    image: ghcr.io/firecrawl/firecrawl:latest
    restart: unless-stopped
    environment:
      REDIS_URL: redis://:${VALKEY_PASSWORD:-changeme}@valkey:6379
      REDIS_RATE_LIMIT_URL: redis://:${VALKEY_PASSWORD:-changeme}@valkey:6379
      # ... other env vars
    depends_on:
      valkey:
        condition: service_healthy
    networks:
      - backend
    ports:
      - "3002:3002"

volumes:
  valkey-data:

networks:
  backend:
    driver: bridge
```

### Production Environment Variables

```env
# .env.production
VALKEY_PASSWORD=your-secure-password-here
REDIS_URL=redis://:${VALKEY_PASSWORD}@valkey:6379
REDIS_RATE_LIMIT_URL=redis://:${VALKEY_PASSWORD}@valkey:6379
```

### Deploy

```bash
docker compose -f deploy/docker-compose.valkey.yaml --env-file .env.production up -d
```

---

## Kubernetes

### Prerequisites

- Kubernetes cluster 
- kubectl configured

### Firecrawl Deployment

Create `deploy/kubernetes/firecrawl.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: firecrawl-api
  namespace: firecrawl
spec:
  replicas: 2
  selector:
    matchLabels:
      app: firecrawl-api
  template:
    metadata:
      labels:
        app: firecrawl-api
    spec:
      containers:
      - name: api
        image: ghcr.io/firecrawl/firecrawl:latest
        env:
        - name: VALKEY_PASSWORD
          valueFrom:
            secretKeyRef:
              name: valkey-secret
              key: password
        - name: REDIS_URL
          value: "redis://:$(VALKEY_PASSWORD)@valkey:6379"
        - name: REDIS_RATE_LIMIT_URL
          value: "redis://:$(VALKEY_PASSWORD)@valkey:6379"
        ports:
        - containerPort: 3002
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
---
apiVersion: v1
kind: Service
metadata:
  name: firecrawl-api
  namespace: firecrawl
spec:
  selector:
    app: firecrawl-api
  ports:
  - port: 3002
    targetPort: 3002
  type: ClusterIP
```

### Deploy to Kubernetes

```bash
kubectl create namespace firecrawl
kubectl apply -f deploy/kubernetes/valkey.yaml
kubectl apply -f deploy/kubernetes/firecrawl.yaml

# Verify
kubectl get pods -n firecrawl
kubectl logs -n firecrawl deployment/firecrawl-api
```

---

## Self-Hosted Valkey

### Ubuntu/Debian

```bash
# Install dependencies
sudo apt update
sudo apt install -y build-essential tcl

# Download and build Valkey
wget https://github.com/valkey-io/valkey/archive/refs/tags/7.2.5.tar.gz
tar xzf 7.2.5.tar.gz
cd valkey-7.2.5
make
sudo make install

# Create config directory
sudo mkdir -p /etc/valkey
sudo cp valkey.conf /etc/valkey/

# Edit config
sudo nano /etc/valkey/valkey.conf
```

**Recommended config changes:**

```conf
# /etc/valkey/valkey.conf
bind 0.0.0.0
port 6379
requirepass your-secure-password
daemonize yes
pidfile /var/run/valkey.pid
logfile /var/log/valkey/valkey.log
dir /var/lib/valkey
appendonly yes
appendfsync everysec
maxmemory 2gb
maxmemory-policy allkeys-lru
```

### Systemd Service

Create `/etc/systemd/system/valkey.service`:

```ini
[Unit]
Description=Valkey In-Memory Data Store
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/bin/valkey-server /etc/valkey/valkey.conf
ExecStop=/usr/local/bin/valkey-cli -a your-secure-password shutdown
Restart=always
User=valkey
Group=valkey

[Install]
WantedBy=multi-user.target
```

```bash
# Create user and directories
sudo useradd -r -s /bin/false valkey
sudo mkdir -p /var/lib/valkey /var/log/valkey
sudo chown valkey:valkey /var/lib/valkey /var/log/valkey

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable valkey
sudo systemctl start valkey

# Verify
sudo systemctl status valkey
valkey-cli -a your-secure-password ping
```

### Connect Firecrawl

```env
# .env
REDIS_URL=redis://:your-secure-password@your-valkey-host:6379
REDIS_RATE_LIMIT_URL=redis://:your-secure-password@your-valkey-host:6379
```