# Self-hosting Firecrawl

Want to get Firecrawl running? Start with the
[Firecrawl self-hosting guide](https://docs.firecrawl.dev/contributing/self-host).
It takes you from checkout to a successful scrape with Docker Compose.

Use this file when you are changing the baseline. It stays with the source, so
the services and configuration match the revision you checked out.

## Pick the guide for the job

| If you need to decide or do this | Start here |
| --- | --- |
| Decide whether self-hosting fits and run the first scrape | [Public self-hosting guide](https://docs.firecrawl.dev/contributing/self-host) |
| Check which variables and services exist at this revision | [Root Compose configuration](./docker-compose.yaml) |
| Adapt a Kubernetes deployment | [Kubernetes manifests](./examples/kubernetes/cluster-install/) or [Helm chart](./examples/kubernetes/firecrawl-helm/) |
| Change Firecrawl product code | [Running Locally](https://docs.firecrawl.dev/contributing/guide), then the [contribution guide](./CONTRIBUTING.md) |
| Connect an agent or terminal client | [Local MCP](https://docs.firecrawl.dev/mcp-server/local) or [Firecrawl CLI](https://docs.firecrawl.dev/sdks/cli#connect-the-cli-to-self-hosted-firecrawl) |

## Keep the first run simple

- **Release: an exact tag.** Review the target release's Compose file before
  changing it. A checkout of `main` and floating image tags can change
  independently.
- **API authentication: `USE_DB_AUTHENTICATION=false`.** Add authentication
  after provisioning the required database schema and application
  configuration. Changing this variable alone is not a complete authenticated
  deployment.
- **Queue: NuQ PostgreSQL.** Keep it unless you intentionally set
  `NUQ_BACKEND=fdb` and are prepared to operate FoundationDB.
- **Scraping: bundled Playwright with basic fetch fallback.** Connect and
  configure a separate engine such as Fire-engine only when you need it.
- **AI-backed features: no model provider.** Connect OpenAI, an OpenAI-compatible
  endpoint, or Ollama when a feature needs it.
- **Queue administration UI: off.** Enable it only with a strong
  `BULL_AUTH_KEY` and restricted network access.

Get this baseline working before swapping backends or adding providers.

The root `.env` overrides only variables referenced by `docker-compose.yaml`.
Do not use `apps/api/.env.example` as a drop-in Compose contract.

## What the stack runs

At this revision, Compose runs the Firecrawl API and workers, Playwright, Redis,
RabbitMQ, NuQ PostgreSQL, and FoundationDB services for the optional queue
backend. Only the API is published to the host by default, on port `3002`.

Self-hosting gives you source and infrastructure control. You also own
security, availability, capacity, upgrades, data retention, and compliance.

## Before production

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

Stuck? Open a
[self-host issue template](https://github.com/firecrawl/firecrawl/issues/new?template=self_host_issue.md)
or join the [Firecrawl Discord community](https://discord.gg/firecrawl).
