<!-- agent-routing:start -->
## Setting Firecrawl up for someone? Start here

If you are an AI agent and the person you work with asked for Firecrawl, choose the path that fits what they need before you run anything. Do not start the Docker stack unless they asked for a scraping service.

| What they need | What to do |
| --- | --- |
| Web data inside this agent or another MCP client | Fetch the onboarding skill below and follow the path it gives you. It covers the hosted setup and the local engine that runs on their machine. |
| Their own scraping service for an app or a team | Self-host the full server. Follow `SELF_HOST.md` at the repository root. |
| A change to Firecrawl's own code | Follow the contributor steps in `AGENTS.md` at the repository root. |

```sh
curl -s https://firecrawl.dev/agent-onboarding/SKILL.md
```

The onboarding skill is the one place setup steps are kept current, so this file does not repeat them. If you cannot reach it, `apps/engine/README.md` has the local engine's commands.
<!-- agent-routing:end -->

## Changing Firecrawl's code

Firecrawl is a web scraper API. The directory you have access to is a monorepo:
 - `apps/api` has the actual API and worker code
 - `apps/engine` is the local engine, a single Rust binary
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
3. Run your tests using `pnpm harness pnpm exec vitest run ...`
  - `pnpm harness` is a command that gets the API server and workers up for you to run the tests. Don't try to `pnpm start` manually.
  - The full test suite takes a long time to run, so you should try to only execute the relevant tests locally, and let CI run the full test suite.
4. Push to a branch, open a PR, and let CI run to verify your win condition.
Keep these steps in mind while building your TODO list.

Never bypass `knip` failures (e.g. with `git commit --no-verify`). If the pre-commit `knip` check fails, fix the reported unused exports/files — even if they predate your change — before committing.