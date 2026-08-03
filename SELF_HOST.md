# Self-hosting Firecrawl

Use the [Firecrawl self-hosting guide](https://docs.firecrawl.dev/contributing/self-host)
when your goal is a first successful Docker Compose deployment. It recommends
an evaluation path, explains the tradeoffs, and ends with a functional scrape.

Use this file when you need revision-specific context before changing that
baseline. It travels with the source and intentionally does not duplicate the
quickstart.

## Choose the right source

| If you need to decide or do this | Start here |
| --- | --- |
| Decide whether self-hosting fits and run the first scrape | [Public self-hosting guide](https://docs.firecrawl.dev/contributing/self-host) |
| Check which variables and services exist at this revision | [Root Compose configuration](./docker-compose.yaml) |
| Adapt a Kubernetes deployment | [Kubernetes manifests](./examples/kubernetes/cluster-install/) or [Helm chart](./examples/kubernetes/firecrawl-helm/) |
| Change Firecrawl product code | [Contributing guide](./CONTRIBUTING.md) |

## Keep these defaults for the first run

- **Source revision → exact release tag.** Change it after reviewing the Compose
  file from the target release. A checkout of `main` and floating image tags can
  change independently.
- **API authentication → `USE_DB_AUTHENTICATION=false`.** Change it after
  provisioning the additional database schema and application configuration.
  Changing this variable alone is not a complete authenticated deployment.
- **Queue backend → NuQ PostgreSQL.** Change it when you intentionally set
  `NUQ_BACKEND=fdb` and are prepared to operate the FoundationDB backend.
- **Scraping engines → bundled Playwright with basic fetch fallback.** Change
  them after supplying and configuring a separate engine such as Fire-engine.
- **AI-backed features → no model provider.** Change this after configuring
  OpenAI, an OpenAI-compatible endpoint, or Ollama.
- **Queue administration UI → disabled.** Enable it only with a strong
  `BULL_AUTH_KEY` and restricted network access.

The root `.env` overrides only variables referenced by `docker-compose.yaml`.
Do not use `apps/api/.env.example` as a drop-in Compose contract.

## What the default stack commits you to

At this revision, Compose runs the Firecrawl API and workers, Playwright, Redis,
RabbitMQ, NuQ PostgreSQL, and FoundationDB services for the optional queue
backend. Only the API is published to the host by default, on port `3002`.

Self-hosting gives you source and infrastructure control. In return, you own
security, availability, capacity, upgrades, data retention, and compliance.

## Decide before production

- **If the API will leave a trusted network,** add a complete authentication
  design, TLS termination, and network policy first. The default API is
  unauthenticated.
- **If data must survive service replacement,** add and test persistence,
  backups, and recovery for NuQ PostgreSQL, Redis, and RabbitMQ. The root
  Compose file defines no persistent volumes for them.
- **If you change the PostgreSQL settings,** keep the API and database values
  consistent. At this revision, the bundled `pg_cron` configuration targets
  the default `postgres` database.
- **If you publish dependency ports,** secure them explicitly. PostgreSQL,
  Redis, RabbitMQ, and worker ports should remain private by default.
- **If you have availability or scale targets,** define monitoring, resource
  limits, scaling triggers, and upgrade and rollback procedures. The checked-in
  Compose file is a source-aligned starting point, not a production
  architecture.

Treat the Kubernetes and Helm examples as versioned starting points, not as
evidence that these production decisions have been made for you.

For help, use the
[self-host issue template](https://github.com/firecrawl/firecrawl/issues/new?template=self_host_issue.md)
or join the [Firecrawl Discord community](https://discord.gg/firecrawl).
