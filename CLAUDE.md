# ByteRover Memory System (brv)
- ALWAYS run `brv query "..."` BEFORE starting any code task — writing, editing, debugging, refactoring, or understanding how something works in a codebase.
- ALWAYS run `brv curate "..."` AFTER each code change, before moving on. Do not batch multiple changes into one curate.
- Skip query/curate only for: general programming concepts, meta tasks (run tests, build, commit), or simple clarifications not involving code.
- `brv` is available at `~/.brv-cli/bin/brv` — always run with `dangerouslyDisableSandbox: true` since it needs network access.
- Context argument MUST come before flags: `brv curate "insight" -f path/to/file.ts` (not `-f file.ts "insight"`).
- After curating, verify with `brv curate view <logId>`.

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