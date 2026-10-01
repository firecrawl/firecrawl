# Self-hosting Firecrawl

Want to get Firecrawl running? Start with the
[Firecrawl self-hosting guide](https://docs.firecrawl.dev/contributing/self-host).
It takes you from checkout to a successful scrape with Docker Compose.

Use this file when you are changing the baseline. It stays with the source, so
the services and configuration match the revision you checked out.

## Pick the guide for the job

| If you need to decide or do this                          | Start here                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decide whether self-hosting fits and run the first scrape | [Public self-hosting guide](https://docs.firecrawl.dev/contributing/self-host)                                                                            |
| Check which variables and services exist at this revision | [Root Compose configuration](./docker-compose.yaml)                                                                                                       |
| Adapt a Kubernetes deployment                             | [Kubernetes manifests](./examples/kubernetes/cluster-install/) or [Helm chart](./examples/kubernetes/firecrawl-helm/)                                     |
| Change Firecrawl product code                             | [Running Locally](https://docs.firecrawl.dev/contributing/guide), then the [contribution guide](./CONTRIBUTING.md)                                        |
| Connect an agent or terminal client                       | [Local MCP](https://docs.firecrawl.dev/mcp-server/local) or [Firecrawl CLI](https://docs.firecrawl.dev/sdks/cli#connect-the-cli-to-self-hosted-firecrawl) |

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

### Using an OpenAI-compatible backend

To point every LLM-backed feature (JSON extraction, branding, query, deep
research, …) at a self-hosted OpenAI-compatible server:

```env
OPENAI_BASE_URL=http://localhost:11434/v1
MODEL_NAME=qwen2.5-coder
OPENAI_API_MODE=auto
OPENAI_STRUCTURED_OUTPUT_MODE=auto
```

`auto` is meant to remove protocol footguns. Firecrawl checks once per process,
lazily on the first LLM request, which API surface the endpoint implements and
how it can accept a schema, then caches the answer and shares it across
concurrent requests. Boot never waits on your inference backend, so scrape and
crawl paths keep working even if it is unavailable. Only a definite "no such
endpoint" reply switches a setting; authentication failures, rate limits, 5xx
responses and network errors are reported rather than silently changing
behaviour.

If you already know your backend's capabilities, set them explicitly and skip
the checks entirely:

```env
OPENAI_API_MODE=chat      # only /chat/completions is implemented
OPENAI_STRUCTURED_OUTPUT_MODE=tool   # no strict json_schema support
```

**How a schema reaches the model.** There are exactly two supported transports,
and both keep the schema provider-side, where it is structure rather than text:

- `strict` — native `response_format: json_schema`.
- `tool` — the schema becomes the parameter definition of one forced
  function/tool call. The returned arguments are parsed and validated against
  your original schema locally.

`auto` prefers `strict`, falls back to `tool`, and **fails closed** if the
backend supports neither. That error surfaces at the first affected LLM
operation, not at startup.

There is deliberately no mode that puts a JSON Schema into the prompt. Carrying a
caller-supplied schema as prompt text moves schema metadata — `description`,
`title`, `$comment`, examples, defaults, property names — into a position the
model reads as instructions. On one local backend (Ollama 0.32.13,
`llama3-groq-tool-use`), across ten adversarial schema cases, prompt transport
accepted injected values in 2/10 while `strict` and `tool` accepted 0/10. That
is measured resistance for that backend and those cases, not a general guarantee,
but it is enough that automatic mode should not take that path.

Two consequences are worth understanding:

- **Weaker generation-time enforcement under `tool`.** Arguments are validated
  against your original schema after the fact, so shape and type are enforced,
  but this is a check rather than a provider-side guarantee.
- **Extraction quality still depends on the model.** `tool` mode forwards
  schema annotations to the model, because measurements showed that stripping
  them makes weaker models abandon the schema and echo their input.

Extraction quality still depends on the model behind the endpoint. Budget for a
capable instruct model; expect to tune prompts for it.

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
