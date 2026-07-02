# Deploying Firecrawl to Railway

Firecrawl needs **three services** in your Railway project:

| Service | Source |
| --- | --- |
| API + workers | This repo (root `Dockerfile`, picked up automatically) |
| Redis | Railway's Redis database |
| NUQ Postgres | `ghcr.io/firecrawl/nuq-postgres:latest` (custom image — see below) |

A stock Postgres database will **not** work for NUQ: the queue schema
requires the `pg_cron` extension (crawl completion is driven by a
15-second cron job), which Railway's built-in Postgres doesn't ship.

## 1. Redis

Add Railway's Redis database to the project.

## 2. NUQ Postgres

Create an empty service and set its image to
`ghcr.io/firecrawl/nuq-postgres:latest` (or deploy it from this repo by
setting the service's root directory to `apps/nuq-postgres`). Then:

- Attach a **volume** mounted at `/var/lib/postgresql/data`
- Set the variable `POSTGRES_PASSWORD` to a strong password

The image applies the queue schema (`nuq.sql`) automatically on first boot.

## 3. API service

Deploy this repo (root directory unset). Set these variables:

```
REDIS_URL=${{Redis.REDIS_URL}}?family=0
NUQ_DATABASE_URL=postgresql://postgres:${{nuq-postgres.POSTGRES_PASSWORD}}@${{nuq-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/postgres
USE_DB_AUTHENTICATION=false
```

Notes:

- `?family=0` is required because Railway's private network is IPv6-only
  and ioredis defaults to IPv4 DNS resolution.
- `REDIS_RATE_LIMIT_URL` is optional — it falls back to `REDIS_URL`.
- Railway injects `PORT` automatically and the server listens on it
  (bound to `0.0.0.0` by the root Dockerfile). Generate a public domain
  on this service to reach the API.
- Optional extras: `PLAYWRIGHT_MICROSERVICE_URL` (JS rendering — deploy
  `apps/playwright-service-ts` as another service), `OPENAI_API_KEY`
  (LLM extraction), `BULL_AUTH_KEY` (queue dashboard auth).
