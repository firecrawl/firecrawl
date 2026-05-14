<h3 align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/firecrawl/firecrawl/main/img/firecrawl_logo.png"
    height="160"
  >
</h3>

<div align="center">
  <strong>theochinomona.tech self-hosted Firecrawl fork</strong>
</div>

---

# Firecrawl — self-hosted (this fork)

This repo is a fork of [upstream Firecrawl](https://github.com/firecrawl/firecrawl) wired up to run as the production scrape + enrichment stack at **theochinomona.tech**. It is the upstream project plus a thin layer of self-host services and API features. If you want the public API or a managed service, use [firecrawl.dev](https://firecrawl.dev) — this fork is not a drop-in replacement for the cloud product.

## What this fork is for

- Run the full Firecrawl scrape / crawl / batch / map / search stack on our own infrastructure.
- Expose a self-hosted **MCP server** so AI agents can talk to Firecrawl directly without going through the cloud.
- Run **fire-enrich**, our CSV-enrichment + operations dashboard, against the same backend.
- Gate everything behind **Cloudflare Access** so only operator emails reach the dashboard or MCP.

## What we built on top of upstream

| Layer | Addition |
|---|---|
| **API features** | `notifyOnCompletion` — opt-in Slack and/or Discord webhook notifications when a scrape, crawl, or batch-scrape job finishes (success or failure). |
| **Compose services** | Three sidecar services bolted onto upstream's compose stack: `firecrawl-mcp`, `fire-enrich-web`, `cf-access-verifier`. |
| **Database** | `nuq-postgres` now persists via a named volume so the queue and operator principals survive container recreations. `fire-enrich` tables (`principals`, `usage_events`) ship in `apps/nuq-postgres/fire-enrich.sql` and run at initdb in the public schema, sharing the DB with the `nuq.*` queue schema. |
| **Networking** | An external `traefik` Docker network so the host's Traefik can route public hostnames into the stack. The `backend` network stays private for inter-service comms. |
| **Auth** | Cloudflare Access in front of `enrich.theochinomona.tech` and `crawl.theochinomona.tech/mcp`, validated by the `cf-access-verifier` sidecar via Traefik `forwardAuth`. |

Everything else — the API code, workers, playwright service, SDKs — is upstream code. The only in-tree edits are the `notifyOnCompletion` integration points in the API controllers and worker.

---

## Architecture

```
                      Cloudflare (DNS + Access)
                              │
                              ▼
                   Host Traefik (external network)
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  enrich.…/                crawl.…/mcp           crawl.…/*
  fire-enrich-web         firecrawl-mcp        api (Firecrawl)
       │                      │                      │
       └─── forwardAuth ──────┴── cf-access-verifier ┘   (backend network)
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
   nuq-postgres            redis                rabbitmq          playwright-service
   (queue + fire-enrich)
```

### Services

All run from `docker-compose.yaml` at the repo root.

**Upstream Firecrawl (unchanged):**

| Service | Purpose |
|---|---|
| `api` | Firecrawl HTTP API + worker harness (`apps/api`). |
| `playwright-service` | JS rendering / browser pool. |
| `redis` | Rate-limit + caching. |
| `rabbitmq` | Job queue transport. |
| `nuq-postgres` | Postgres backing the `nuq` queue. Persisted via named volume; extended with fire-enrich tables. |

**This fork's additions:**

| Service | Purpose | Public host |
|---|---|---|
| `firecrawl-mcp` | Self-hosted Firecrawl MCP server. Built from sibling repo `../firecrawl-mcp-server`. | `crawl.theochinomona.tech/mcp` |
| `fire-enrich-web` | Ops dashboard + CSV-enrichment app. Built from sibling repo `../fire-enrich`. | `enrich.theochinomona.tech` |
| `cf-access-verifier` | Validates Cloudflare Access JWTs for Traefik `forwardAuth`. Backend-only — never exposed publicly. | (internal) |

The compose file pulls build contexts from `../fire-enrich/` and `../firecrawl-mcp-server/`, so the parent directory must contain those repos before you build. See *Sibling repos* below.

---

## Quick start (self-host)

### One-liner install

On the production server:

```bash
curl -fsSL https://raw.githubusercontent.com/TheophilusChinomona/firecrawl/release/install.sh | bash
```

That installer (`install.sh` at the repo root):

1. Checks for `docker` + `docker compose v2`.
2. Creates `~/firecrawl-stack/` (override with `INSTALL_DIR=/path`).
3. Downloads `deploy/docker-compose.yaml` and `deploy/.env.example`.
4. Drops a stub `.env` and pauses for you to fill in real values.
5. Logs in to GHCR if needed, then `docker compose pull && up -d`.
6. Optionally installs Watchtower (polls GHCR every 2 min, restarts containers when `:latest` advances).

The compose file under `deploy/` uses **`image:` directives only** — every service pulls a pre-built image from `ghcr.io/theophiluschinomona/*`. No source-clone, no local build, no sibling repos required on the production host.

### Required env vars (minimum)

When the installer pauses for you to edit `.env`, fill in at least:

- `CF_ACCESS_TEAM`, `CF_ACCESS_AUD_DASHBOARD`, `CF_ACCESS_AUD_MCP` — from Cloudflare Zero Trust → Access → Applications.
- `OPERATOR_EMAILS` — comma-separated dashboard allowlist.
- `KEY_ENCRYPTION_KEY`, `SERVER_PEPPER`, `ADMIN_COOKIE_SECRET` — `openssl rand -base64 32` each.
- `POSTGRES_PASSWORD`, `BULL_AUTH_KEY`.
- `OPENAI_API_KEY` (or `LLM_API_KEY` for the MCP server's enrich/research tools — OpenRouter by default).
- `DASHBOARD_HOST`, `MCP_HOST` — your hostnames; defaults are this fork's.
- `TRAEFIK_NETWORK` — name of the external Docker network your Traefik instance routes from. Defaults to `traefik`.

Optional:

- `NOTIFY_SLACK_WEBHOOK_URL` and/or `NOTIFY_DISCORD_WEBHOOK_URL` — to receive job-completion notifications when callers pass `notifyOnCompletion: true`.

### Verify

- API: `curl https://$MCP_HOST/v2/scrape -H "Authorization: Bearer $FIRECRAWL_API_KEY" -d '{"url":"firecrawl.dev"}'`
- MCP: `https://$MCP_HOST/mcp` (after Cloudflare Access login)
- Dashboard: `https://$DASHBOARD_HOST` (after Cloudflare Access login; email must be in `OPERATOR_EMAILS`)

### How the images get built

This is a monorepo. Both upstream sibling projects (`fire-enrich`, `firecrawl-mcp-server`) live as `git subtree` directories at the repo root:

```
firecrawl/
├── apps/                       # upstream firecrawl
├── fire-enrich/                # subtree
└── firecrawl-mcp-server/       # subtree
```

All eight images (`firecrawl`, `playwright-service`, `nuq-postgres`, `go-html-to-md-service`, `firecrawl-redis`, `cf-access-verifier`, `fire-enrich-web`, `firecrawl-mcp`) are built and pushed to your GHCR by workflows in `.github/workflows/deploy-*.{yml,yaml}` — every one runs as the repo via `secrets.GITHUB_TOKEN`, so packages auto-attach to this repo and inherit its public visibility on first push. No manual UI flips, no separate sibling-repo CI to maintain.

To pull updates from each upstream into the subtrees:

```bash
git subtree pull --squash --prefix=fire-enrich \
  https://github.com/firecrawl/fire-enrich.git main
git subtree pull --squash --prefix=firecrawl-mcp-server \
  https://github.com/firecrawl/firecrawl-mcp-server.git main
```

### Updates

Push to the `release` branch of this repo. The deploy-* workflows build the API + playwright + nuq-postgres images and push to GHCR. Watchtower on the prod server pulls + restarts the affected containers within ~2 minutes. To upgrade `install.sh` itself or the compose file, rerun the curl one-liner.

### Dev mode (build locally)

For local development with hot reload and on-machine builds, the original `docker-compose.yaml` at the repo root still works — it has `build:` directives and expects the sibling repos cloned alongside this one. Use it for development; use `deploy/docker-compose.yaml` for production.

---

## Custom API features

### `notifyOnCompletion`

Pass `notifyOnCompletion: true` on any scrape, crawl, or batch-scrape request to fire a Slack and/or Discord notification when the job finishes:

```bash
curl -X POST https://crawl.theochinomona.tech/v2/crawl \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -d '{
    "url": "https://docs.firecrawl.dev",
    "limit": 100,
    "notifyOnCompletion": true
  }'
```

The payload includes job type, ID, source URL, document count, duration, and on failure the error message. Notifications are fire-and-forget — they never block or fail the job. Webhooks are configured globally via `NOTIFY_SLACK_WEBHOOK_URL` and `NOTIFY_DISCORD_WEBHOOK_URL`. Implementation: `apps/api/src/services/notification/completion-notification.ts`.

---

## Operations

- **Logs:** `docker compose logs -f <service>` — all services use json-file logging with rotation (5–10 MB per file, 2–3 files).
- **Persistence:** the `nuq-postgres-data` volume holds both the queue and fire-enrich principals. Blowing it away resets every API key and operator session.
- **Bull-Board:** mounted under the dashboard, gated by `BULL_AUTH_KEY`. Never exposed to the browser directly.
- **Updating from upstream:** rebase this fork on upstream `main`, then rebuild with `docker compose up -d --build`. The three additional services and the `notifyOnCompletion` controller integration are the only places where upstream merges typically need conflict resolution.

---

## About upstream Firecrawl

Upstream Firecrawl is the underlying scrape engine. The endpoints (`/v2/scrape`, `/v2/crawl`, `/v2/map`, `/v2/search`, `/v2/batch/scrape`, `/v2/agent`), the SDK ecosystem, and the worker pipeline are all from upstream and behave the same here. For API reference, request/response shapes, and SDK usage, see:

- **Docs:** https://docs.firecrawl.dev
- **API reference:** https://docs.firecrawl.dev/api-reference/introduction
- **Upstream repo:** https://github.com/firecrawl/firecrawl

This README intentionally does not duplicate that material — anything API-shape-related is upstream's source of truth.

---

## License

This project inherits the upstream license: GNU Affero General Public License v3.0 (AGPL-3.0). The SDKs and some UI components are MIT. See the `LICENSE` files in specific directories.

---

**It is the sole responsibility of end users to respect websites' policies when scraping.** Users are advised to adhere to applicable privacy policies and terms of use. By default, Firecrawl respects robots.txt directives. By using Firecrawl, you agree to comply with these conditions.

<p align="right" style="font-size: 14px; color: #555; margin-top: 20px;">
  <a href="#readme-top" style="text-decoration: none; color: #007bff; font-weight: bold;">
    ↑ Back to Top ↑
  </a>
</p>
