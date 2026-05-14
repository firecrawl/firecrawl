# Deploy Branch Protection Rules

## Required GitHub Branch Protection Settings

### Branch: `deploy`

**Required status checks:**
- [x] Require branches to be up to date before merging
- [x] Require status checks to pass before merging
- [x] Require up-to-date branches before merging

**Status checks that must pass:**
- `test-server` (existing test suite)
- `deploy-self-hosted` (our new deployment workflow)

**Branch protection rules:**
- [x] Require a pull request before merging
- [x] Require approvals (minimum 1)
- [x] Dismiss stale pull request approvals when new commits are pushed
- [x] Require review from Code Owners
- [x] Restrict who can dismiss pull request reviews
- [x] Allow specified actors to bypass required pull requests:
  - theo (repository owner/admin)

**Allowed to merge:**
- theo (repository owner/admin)

**Allowed to push:**
- theo (repository owner/admin)

## Workflow

1. **Development** → Push to `main` branch
2. **Code Review** → Create PR from `main` → `deploy`
3. **Approval** → theo reviews and approves PR
4. **Merge** → Auto-deploy to self-hosted server
5. **Rollback** → Use `backward-compatible-agent-api` branch if needed

## Environment Secrets Required

Add these to GitHub repository secrets:

```
SERVER_HOST=your.server.com
SERVER_USER=deploy
SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\n...
DEPLOY_PATH=/opt/firecrawl
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```