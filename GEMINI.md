<!-- agent-routing:start -->
## Setting Firecrawl up for someone? Start here

If you are an AI agent and the person you work with asked for Firecrawl, choose the path that fits what they need before you run anything. Do not start the Docker stack unless they asked for a scraping service.

| What they need | What to do |
| --- | --- |
| Web data inside this agent or another MCP client, running on their machine | Install the local engine with the commands below. |
| The quickest setup with nothing to build | Run `npx -y firecrawl-cli@latest init --all --browser`. It uses hosted Firecrawl and has a free tier. |
| Their own scraping service for an app or a team | Self-host the full server. Follow `SELF_HOST.md` at the repository root. |
| A change to Firecrawl's own code | Follow the contributor steps in `AGENTS.md` at the repository root. |

The local engine is one binary with no Docker, database or queue. Build it and connect it in three commands, run from the repository root.

```sh
cd apps/engine && cargo build --release
./target/release/firecrawl-engine init
./target/release/firecrawl-engine scrape https://example.com --markdown
```

- `init` adds Firecrawl as an MCP server to the AI coding tools it finds on the machine and backs up each config file first. Restart the agent afterwards.
- To connect a client by hand, register the command `firecrawl-engine mcp` as a stdio MCP server.
- Scrape, crawl and map run on the machine. Search and Alexandria data providers run on Firecrawl cloud, and `firecrawl-engine login` signs in with one browser step. `FIRECRAWL_CLOUD=off` keeps every request on the machine.
- If the machine has no Rust toolchain, use the quickest setup in the table. Do not install Rust without asking.

`apps/engine/README.md` has every command and setting.
<!-- agent-routing:end -->

## Working in this repository

Read `AGENTS.md` at the repository root for how the code is laid out and how to test a change.
