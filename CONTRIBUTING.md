# Contributing to Firecrawl

Thanks for helping make Firecrawl better. Keep each change focused, prove the behavior you changed, and make the pull request easy to review.

## Choose the right workflow

| If you want to | Start here |
| --- | --- |
| Change the API, workers, or tests | [Run Firecrawl locally for development](https://docs.firecrawl.dev/contributing/guide) |
| Run Firecrawl on your own infrastructure without changing product code | [Self-hosting Firecrawl](https://docs.firecrawl.dev/contributing/self-host) |
| Change an SDK | The matching directory under [`apps/`](./apps/) and its package scripts |
| Improve the public documentation | The [`firecrawl-docs`](https://github.com/firecrawl/firecrawl-docs) repository |

Local development and self-hosting are different paths. Development uses the API harness and `apps/api/.env`; the Docker Compose deployment uses the root configuration. Do not copy one environment file into the other.

## Set up API development

The public [Running Locally](https://docs.firecrawl.dev/contributing/guide) guide is the canonical first-success path. It covers Node.js 22, pnpm `11.4.0`, Redis, the harness-managed PostgreSQL and RabbitMQ containers, and a verified local scrape.

The source-owned commands live in [`apps/api/package.json`](./apps/api/package.json). From `apps/api`:

```bash
pnpm install
pnpm start
```

`pnpm start` builds Firecrawl and launches the API, workers, and local dependency containers. Keep Redis running separately as described in the public guide.

## Make a focused change

1. Fork the repository and create a branch whose name describes the change.
2. Reproduce the current behavior before editing.
3. Add or update coverage for the successful path and relevant failures.
4. Make the smallest change that satisfies those tests.
5. Run the narrowest useful checks before opening a pull request.

For API changes, prefer end-to-end snippet coverage when the behavior crosses routes, workers, queues, or scraping engines.

## Run API tests with the harness

From `apps/api`, run the snippet suites with their dependencies:

```bash
pnpm harness pnpm test:snips
```

For a narrower test, pass the relevant Vitest path through the same harness:

```bash
pnpm harness pnpm exec vitest run path/to/test.ts
```

The harness starts the API, workers, PostgreSQL, and RabbitMQ for the command, then cleans up the processes and containers it started.

Do not bypass failing checks. Fix failures caused by your change and call out unrelated repository failures with enough detail for a reviewer to reproduce them.

## Open the pull request

Include:

- why the change is needed;
- what behavior changed;
- the exact tests or checks you ran;
- any configuration, migration, security, or deployment impact; and
- screenshots or request/response evidence when they make the result easier to verify.

Keep credentials, local environment files, raw user data, and generated secrets out of commits and pull requests.

## Get help

Use [GitHub issues](https://github.com/firecrawl/firecrawl/issues) for reproducible bugs and feature discussions. For community help, join the [Firecrawl Discord](https://discord.gg/firecrawl).
