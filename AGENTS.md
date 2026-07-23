Firecrawl is a web scraper API. The directory you have access to is a monorepo:
 - `apps/api` has the actual API and worker code
 - `apps/*-sdk` are various SDKs

When making changes to the API, here are the general steps you should take:
1. Write some end-to-end tests that assert your win conditions, if they don't already exist
  - 1 happy path (more is encouraged if there are multiple happy paths with significantly different code paths taken)
  - 1+ failure path(s)
  - Generally, E2E (called `snips` in the API) is always preferred over unit testing.
  - In the API, always use `scrapeTimeout` from `./lib` to set the timeout you use for scrapes.
  - These tests will be ran on a variety of configurations. You should gate tests in the following manner:
    - If it requires fire-engine: `!process.env.TEST_SUITE_SELF_HOSTED`
    - If it requires AI: `!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL`
2. Write code to achieve your win conditions
3. Run your tests using `pnpm harness jest ...`
  - `pnpm harness` is a command that gets the API server and workers up for you to run the tests. Don't try to `pnpm start` manually.
  - The full test suite takes a long time to run, so you should try to only execute the relevant tests locally, and let CI run the full test suite.
4. Push to a branch, open a PR, and let CI run to verify your win condition.
Keep these steps in mind while building your TODO list.

## Cursor Cloud specific instructions

All work happens in `apps/api`; there is no root workspace. Standard build/lint/test/run commands live in `apps/api/package.json`, `CLAUDE.md`, `CONTRIBUTING.md`, and `SELF_HOST.md` — use those. The notes below are the non-obvious caveats for this cloud VM (the update script has already refreshed dependencies).

### Toolchain (baked into the snapshot)
- Node 22 + `pnpm@11.4.0` via corepack (matches the `packageManager` pin). Go 1.24 is installed at `/usr/local/go` and shadows the apt `go-1.22` via `/usr/local/bin/go`. Rust stable is present for the napi native addon.
- The `foundationdb` npm package builds a native addon at install time and needs the FoundationDB C client (`/usr/include/foundationdb/fdb_c.h`, `/usr/lib/libfdb_c.so`); the `foundationdb-clients` 7.3.63 `.deb` is installed system-wide. FDB itself is only used when `NUQ_BACKEND=fdb`.
- `pnpm install` (from `apps/api`) compiles the Rust napi addon (`@mendable/firecrawl-rs`, ~2 min); it needs `build-essential`, `pkg-config`, `python3` (all preinstalled).

### Services needed to run the API (start these yourself; the update script does NOT)
- Docker daemon: start with `sudo dockerd` if `docker info` fails. It is configured for this Firecracker VM (`/etc/docker/daemon.json`: `fuse-overlayfs` storage driver + `containerd-snapshotter: false`, required for Docker 29). The `ubuntu` user is in the `docker` group.
- Redis is **not** managed by the harness — run `redis-server` (listens on `localhost:6379`) before starting the API.
- The harness (`pnpm dev` / `pnpm harness ...`) auto-provisions the NuQ Postgres and RabbitMQ containers via Docker and tears them down on exit; it builds `firecrawl-nuq-postgres` from `apps/nuq-postgres` (Postgres 17 + `pg_cron`).
- `apps/api/.env` (gitignored) holds local config: `REDIS_URL`/`REDIS_RATE_LIMIT_URL=redis://localhost:6379`, `USE_DB_AUTHENTICATION=false`, `USE_GO_MARKDOWN_PARSER=true`, `TEST_API_KEY=test`, `TEST_TEAM_ID=bypass`, `TEST_SUITE_SELF_HOSTED=true`.

### Port-5432 conflict caveat (only matters if the `search` repo's Postgres is also running)
- The harness hardcodes publishing the NuQ Postgres on host port `5432`, which collides with the `search` repo's local Postgres 16. To run both stacks at once, start firecrawl's queue backends yourself on an alternate port and set env vars so the harness skips container management:
  - `docker run -d --name firecrawl-nuq-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management`
  - `docker run -d --name firecrawl-nuq-postgres -p 5433:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres firecrawl-nuq-postgres:latest`
  - in `.env`: `NUQ_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres`, `NUQ_DATABASE_URL_LISTEN=` (same), `NUQ_RABBITMQ_URL=amqp://localhost:5672`.
- If you only need firecrawl, leave those env vars unset and ensure nothing else holds `5432`; the harness provisions everything automatically.

### Running / testing
- Bring up the full stack (API + queue-worker + nuq-workers + extract-worker) with `pnpm dev` (dev, tsc-watch) or `node dist/src/harness.js --start-built` (after `pnpm build`). Smoke test a scrape: `curl -X POST localhost:3002/v1/scrape -H 'Authorization: Bearer test' -H 'Content-Type: application/json' -d '{"url":"https://example.com","formats":["markdown"]}'`.
- E2E ("snips") are run via `pnpm harness pnpm test:snips` (the harness brings up its own stack, so stop any stack you started on the same ports first). In this VM (self-hosted, no fire-engine/AI/GCS), snips that need those hosted backends return 400/are skipped — that is expected; the full matrix runs in CI. The `test:snips` line in `package.json` is the source of truth; `pnpm harness jest ...` in the workflow notes above is outdated — the runner is vitest.
- Lint/quality gate is `pnpm knip` (plus Prettier via lint-staged); it runs in the husky pre-commit hook. Never bypass a knip failure with `--no-verify`.