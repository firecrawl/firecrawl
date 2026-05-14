# Self-Hosted Firecrawl Deployment Guide

## Overview

This guide sets up automated deployment to your self-hosted server when code is merged to the `deploy` branch.

## Branch Strategy

```
main (development) → deploy (production)
     ↑                    ↓
     └─ backward-compatible-agent-api (rollback)
```

## Setup Steps

### 1. GitHub Repository Settings

#### Branch Protection for `deploy`
1. Go to Settings → Branches
2. Add rule for branch `deploy`
3. Configure:
   - ✅ Require pull request before merging
   - ✅ Require approvals (1 minimum)
   - ✅ Require status checks (see below)
   - ✅ Restrict pushes to theo only
   - ✅ Allow theo to bypass required PRs

#### Required Status Checks
- `test-server` (existing tests)
- `deploy-self-hosted` (deployment workflow)

### 2. GitHub Secrets Setup

Add these to your repository secrets (Settings → Secrets and variables → Actions):

```bash
# Server connection
SERVER_HOST=your-server.com
SERVER_USER=deploy
SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----
...

# Deployment path
DEPLOY_PATH=/opt/firecrawl

# Notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### 3. Server Setup

#### SSH Key Setup
```bash
# On your server
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy

# Generate SSH key pair for GitHub Actions
ssh-keygen -t rsa -b 4096 -C "github-actions@your-server.com"

# Add public key to authorized_keys
mkdir -p /home/deploy/.ssh
cat id_rsa.pub >> /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

#### Directory Setup
```bash
# Create deployment directory
sudo mkdir -p /opt/firecrawl
sudo chown deploy:deploy /opt/firecrawl

# Copy docker-compose.yaml and env files
# (GitHub Actions will handle this)
```

### 4. Deployment Workflow

#### Normal Development Flow
1. **Develop** on `main` branch
2. **Test** locally with `pnpm harness jest`
3. **Create PR** from `main` → `deploy`
4. **Review** code changes
5. **Approve & Merge** PR (only theo can approve)
6. **Auto-deploy** to server via GitHub Actions

#### Rollback Flow
```bash
# If you need to rollback to backward-compatible version
git checkout deploy
git reset --hard backward-compatible-agent-api
git push --force-with-lease
```

## Monitoring

### Health Checks
- API: `curl http://localhost:3002/`
- MCP: `curl http://localhost:3000/health`

### Logs
```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f api
docker-compose logs -f firecrawl-mcp
```

### Updates
```bash
# Manual update
docker-compose pull
docker-compose up -d

# Or use the deploy script
./deploy.sh
```

## Security Considerations

- ✅ **SSH Key Authentication**: GitHub Actions uses SSH keys
- ✅ **Branch Protection**: Only approved PRs can deploy
- ✅ **Limited Access**: Only theo can push/merge to deploy
- ✅ **Environment Secrets**: Sensitive data stored securely
- ✅ **Health Checks**: Automatic verification after deployment

## Troubleshooting

### Deployment Fails
1. Check GitHub Actions logs
2. Verify SSH connection: `ssh deploy@your-server.com`
3. Check server disk space: `df -h`
4. Verify Docker is running: `docker ps`

### Service Won't Start
1. Check logs: `docker-compose logs api`
2. Verify environment variables
3. Check port conflicts: `netstat -tlnp`

### Rollback Issues
1. Use the `backward-compatible-agent-api` branch
2. Force push if needed: `git push --force-with-lease`
3. Verify with health checks

## Files Created

- `.github/workflows/deploy-self-hosted.yml` - GitHub Actions deployment
- `deploy.sh` - Manual deployment script
- `DEPLOY_SETUP.md` - This setup guide