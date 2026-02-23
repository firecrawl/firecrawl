# Firecrawl MCP Server Installation Guide

This guide provides comprehensive installation instructions for Firecrawl MCP server across 20+ MCP-compatible environments. Firecrawl MCP server enables web scraping, crawling, search, and extraction capabilities within your favorite AI assistants and development tools.

## Prerequisites

- **Firecrawl API Key**: Get your API key from [firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys). The key starts with `fc-`.
- **Node.js 18+** (if running locally)
- **npm** or **npx** (for local installation)

## Quick Start

### Running with npx (Temporary)

```bash
env FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

### Manual Installation (Global)

```bash
npm install -g firecrawl-mcp
```

Then run:

```bash
env FIRECRAWL_API_KEY=fc-YOUR_API_KEY firecrawl-mcp
```

### Remote Hosted URL (No Local Server)

Firecrawl provides a remote MCP server endpoint. Use this URL in any MCP client that supports HTTP transport:

```
https://mcp.firecrawl.dev/{FIRECRAWL_API_KEY}/v2/mcp
```

Replace `{FIRECRAWL_API_KEY}` with your actual key (without braces).

---

## Environment-Specific Instructions

### AI Code Editors

#### 1. Cursor

Cursor supports MCP servers via JSON configuration.

**Requirements**: Cursor version 0.45.6+

**Configuration**:

1. Open Cursor Settings → Features → MCP Servers.
2. Click "+ Add new global MCP server".
3. Enter the following JSON (for Cursor v0.48.6+):

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

For Cursor v0.45.6, use the UI to add a new MCP server with:
- **Name**: `firecrawl-mcp`
- **Type**: `command`
- **Command**: `env FIRECRAWL_API_KEY=your-api-key npx -y firecrawl-mcp`

**Windows Users**: Use `cmd /c "set FIRECRAWL_API_KEY=your-api-key && npx -y firecrawl-mcp"`

**Verification**: Restart Cursor, open Composer Agent (Cmd+L on Mac), ask about available tools.

#### 2. Windsurf

Windsurf (by Codeium) supports MCP servers via `model_config.json`.

**Configuration**:

Add the following to `./codeium/windsurf/model_config.json`:

```json
{
  "mcpServers": {
    "mcp-server-firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Verification**: Restart Windsurf; Firecrawl tools should be available.

#### 3. VS Code & VS Code Insiders

VS Code supports MCP through the Copilot Chat extension.

**One-Click Installation**:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=firecrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Firecrawl%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22firecrawl-mcp%22%5D%2C%22env%22%3A%7B%22FIRECRAWL_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D)

**Manual Configuration**:

Add to your User Settings (JSON) (`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)"):

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apiKey",
        "description": "Firecrawl API Key",
        "password": true
      }
    ],
    "servers": {
      "firecrawl": {
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": {
          "FIRECRAWL_API_KEY": "${input:apiKey}"
        }
      }
    }
  }
}
```

**Project-Level Configuration**:

Create `.vscode/mcp.json` in your workspace with the same content.

**Verification**: Open Copilot Chat and ask "What MCP servers are available?"

#### 4. Zed

Zed is a high-performance code editor with MCP support.

**Configuration**:

Add to Zed `settings.json`:

```json
{
  "context_servers": {
    "firecrawl-mcp": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Verification**: Open Zed's AI assistant and ask for Firecrawl tools.

#### 5. JetBrains AI Assistant

Works across IntelliJ IDEA, PyCharm, WebStorm, etc.

**Configuration**:

1. Go to **Settings → Tools → AI Assistant → Model Context Protocol (MCP)**.
2. Click **+ Add**.
3. Select **Command** and switch to **JSON** view.
4. Add:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

5. Click **Apply**.

**Verification**: Type `/` in AI chatbox; Firecrawl tools should appear.

### Desktop AI Assistants

#### 6. Claude Desktop

Claude Desktop supports MCP servers via configuration file.

**Configuration**:

Edit `claude_desktop_config.json` (location varies by OS):

```json
{
  "mcpServers": {
    "firecrawl": {
      "url": "https://mcp.firecrawl.dev/v2/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

For local server:

```json
{
  "mcpServers": {
    "mcp-server-firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Verification**: Restart Claude Desktop; Firecrawl tools will appear in the tool list.

#### 7. Claude Code

Claude Code (Anthropic's CLI tool) supports MCP via `claude mcp add`.

**Installation**:

```bash
claude mcp add firecrawl-mcp -e FIRECRAWL_API_KEY=your-api-key -- npx -y firecrawl-mcp
```

**Scope options**:
- `-s project` for project-level configuration (saved in `.mcp.json`)
- `-s user` for user-level configuration (available across all projects)

**Verification**:

```bash
claude mcp list
```

#### 8. Google Antigravity

Google Antigravity is Google's agentic development platform powered by Gemini.

**Via MCP Store** (recommended):

1. Open Google Antigravity.
2. Click the **`⋯`** (more) menu in the Agent pane.
3. Select **MCP Servers**.
4. Search for "Firecrawl" in the MCP Store.
5. Click **Install**.
6. Enter your Firecrawl API key when prompted.

**Manual Configuration**:

Edit `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Verification**: Restart Antigravity or reload the Agent pane, check MCP Servers list.

#### 9. Smithery (Legacy)

Smithery is a package manager for MCP servers.

**Installation**:

```bash
npx -y @smithery/cli install @mendableai/mcp-server-firecrawl --client claude
```

### Terminal & CLI Tools

#### 10. Warp

Warp is a modern terminal with AI features.

**Configuration**:

1. Navigate to **Settings > AI > Manage MCP servers**.
2. Click **+ Add**.
3. Paste:

```json
{
  "firecrawl-mcp": {
    "command": "npx",
    "args": ["-y", "firecrawl-mcp"],
    "env": {
      "FIRECRAWL_API_KEY": "YOUR_API_KEY"
    },
    "working_directory": null,
    "start_on_launch": true
  }
}
```

4. Click **Save**.

**Verification**: In Warp's AI features, ask: "Use Firecrawl to scrape https://example.com"

#### 11. Amp

Amp is a CLI tool for AI agents.

**Installation**:

```bash
amp mcp add firecrawl-mcp -- npx -y firecrawl-mcp
```

Set environment variable `FIRECRAWL_API_KEY` in your shell.

**Verification**:

```bash
amp mcp list
```

#### 12. Gemini CLI

Google's Gemini CLI supports MCP.

**Configuration**:

Edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Verification**: Run `gemini` and use `/mcp list` command.

### Automation & Workflow Platforms

#### 13. n8n

n8n requires HTTP transport mode.

**Start Server in HTTP Mode**:

```bash
env HTTP_STREAMABLE_SERVER=true FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

Server starts at `http://localhost:3000/v2/mcp`.

**Usage**:

In n8n workflow, add an **AI Agent** node, add a new **Tool**, select **MCP Client Tool**, enter endpoint:

```
https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp
```

Set **Server Transport** to **HTTP Streamable**, **Authentication** to **None**.

### Alternative Runtimes

#### 14. Bun Runtime

Run with Bun instead of Node.js.

**Configuration**:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "bunx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

#### 15. Deno Runtime

Run with Deno.

**Configuration**:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "npm:firecrawl-mcp"
      ],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Advanced Deployments

#### 16. Streamable HTTP (Local Server Mode)

Run server using Streamable HTTP locally instead of stdio transport.

```bash
env HTTP_STREAMABLE_SERVER=true FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

Use the URL: `http://localhost:3000/v2/mcp`

#### 17. Docker

Run Firecrawl MCP server in a Docker container.

**Dockerfile**:

```dockerfile
FROM node:18-alpine
WORKDIR /app
RUN npm install -g firecrawl-mcp
CMD ["firecrawl-mcp"]
```

**Build and Run**:

```bash
docker build -t firecrawl-mcp .
docker run -e FIRECRAWL_API_KEY=YOUR_API_KEY -it firecrawl-mcp
```

**MCP Client Configuration**:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "FIRECRAWL_API_KEY=YOUR_API_KEY", "firecrawl-mcp"],
      "transportType": "stdio"
    }
  }
}
```

#### 18. Windows (cmd / PowerShell)

On Windows, use `cmd` or PowerShell.

**Using cmd**:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Using PowerShell**:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "powershell",
      "args": ["-Command", "npx -y firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Generic MCP Clients

#### 19. Any MCP Client Supporting Stdio

Most MCP clients support stdio transport. Use the following configuration pattern:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

#### 20. Any MCP Client Supporting HTTP

For clients that support HTTP transport, use the remote hosted URL:

```
https://mcp.firecrawl.dev/{FIRECRAWL_API_KEY}/v2/mcp
```

Or run your own HTTP server as described in **Streamable HTTP** section.

#### 21. MCP Inspector

MCP Inspector is a debugging tool for MCP servers.

**Configuration**:

Start Firecrawl MCP server in stdio mode, then connect Inspector to the process.

#### 22. MCP CLI

MCP CLI is a command-line interface for interacting with MCP servers.

**Installation**:

```bash
npm install -g @modelcontextprotocol/cli
```

**Usage**:

```bash
mcp connect npx -y firecrawl-mcp --env FIRECRAWL_API_KEY=YOUR_API_KEY
```

#### 23. MCP.so Playground

Use the hosted Firecrawl MCP server directly in the playground.

Visit [MCP.so playground](https://mcp.so/playground?server=firecrawl-mcp-server) to test.

#### 24. Klavis AI

Klavis AI provides an MCP server registry.

Search for "Firecrawl" in Klavis AI's MCP server list and follow their installation steps.

---

## Available Tools Overview

Firecrawl MCP server provides the following tools for web scraping, search, and automation:

| Tool | Description | Best For |
|------|-------------|----------|
| `firecrawl_scrape` | Scrape content from a single URL with advanced options (formats: markdown, JSON, HTML, branding). | Single page content extraction. |
| `firecrawl_batch_scrape` | Scrape multiple URLs efficiently with built-in rate limiting. | Multiple known pages. |
| `firecrawl_map` | Map a website to discover all indexed URLs. | Discovering URLs on a site. |
| `firecrawl_search` | Search the web and optionally extract content from search results. | Finding information across multiple websites. |
| `firecrawl_crawl` | Start an asynchronous crawl job on a website. | Extracting content from multiple related pages. |
| `firecrawl_check_crawl_status` | Check the status of a crawl job. | Monitoring crawl progress. |
| `firecrawl_extract` | Extract structured information from web pages using LLM capabilities. | Extracting specific structured data (prices, names, etc.). |
| `firecrawl_agent` | Autonomous web research agent that independently browses the internet. | Complex research tasks where you don't know exact URLs. |
| `firecrawl_agent_status` | Check the status of an agent job and retrieve results. | Polling agent results. |
| `firecrawl_browser_create` | Create a persistent cloud browser session for interactive automation. | Multi-step browser automation. |
| `firecrawl_browser_execute` | Execute code in a browser session (bash, Python, JavaScript). | Running agent‑browser commands or Playwright scripts. |
| `firecrawl_browser_list` | List browser sessions, optionally filtered by status. | Managing active sessions. |
| `firecrawl_browser_delete` | Destroy a browser session. | Cleaning up after automation. |

For detailed usage and parameters, refer to the [Firecrawl MCP server documentation](https://docs.firecrawl.dev/mcp-server).

### Testing Your Installation

Once configured, you can verify the server is working by asking your AI assistant to use a Firecrawl tool. For example:

- "Scrape https://example.com and give me the markdown."
- "Search for 'latest AI news' and return the top 3 results."
- "Map the website https://firecrawl.dev to see all URLs."

If tools are not appearing, check the client's logs for MCP server startup errors.

---

## Configuration

### Environment Variables

- `FIRECRAWL_API_KEY`: Your Firecrawl API key (required for cloud API)
- `FIRECRAWL_API_URL`: Custom API endpoint for self-hosted instances (optional)
- `HTTP_STREAMABLE_SERVER`: Set to `true` to enable HTTP mode (default: false)
- `FIRECRAWL_RETRY_MAX_ATTEMPTS`: Maximum retry attempts (default: 3)
- `FIRECRAWL_RETRY_INITIAL_DELAY`: Initial delay in ms (default: 1000)
- `FIRECRAWL_RETRY_MAX_DELAY`: Maximum delay in ms (default: 10000)
- `FIRECRAWL_RETRY_BACKOFF_FACTOR`: Exponential backoff multiplier (default: 2)
- `FIRECRAWL_CREDIT_WARNING_THRESHOLD`: Credit warning threshold (default: 1000)
- `FIRECRAWL_CREDIT_CRITICAL_THRESHOLD`: Critical credit threshold (default: 100)

### Configuration Examples

**Cloud API with custom retry**:

```bash
export FIRECRAWL_API_KEY=fc-YOUR_API_KEY
export FIRECRAWL_RETRY_MAX_ATTEMPTS=5
export FIRECRAWL_RETRY_INITIAL_DELAY=2000
export FIRECRAWL_RETRY_MAX_DELAY=30000
export FIRECRAWL_RETRY_BACKOFF_FACTOR=3
```

**Self-hosted instance**:

```bash
export FIRECRAWL_API_URL=https://firecrawl.your-domain.com
export FIRECRAWL_API_KEY=your-api-key  # if authentication required
```

---

## Troubleshooting

### Common Issues

1. **Server fails to start**: Ensure Node.js version 18+ is installed.
2. **API key not recognized**: Verify the key starts with `fc-` and is correct.
3. **MCP client timeout**: Increase startup timeout in client configuration.
4. **Tools not appearing**: Restart the client after configuration changes.
5. **HTTP mode not working**: Ensure `HTTP_STREAMABLE_SERVER=true` and port 3000 is free.
6. **Windows command issues**: Use the cmd or PowerShell configurations above.

### Getting Help

- Visit [Firecrawl documentation](https://docs.firecrawl.dev)
- Join the [Firecrawl Discord](https://discord.gg/gSmWdAkdwd)
- Open an issue on [GitHub](https://github.com/firecrawl/firecrawl-mcp-server/issues)

---

*This guide covers 24+ MCP-compatible environments. For the most up-to-date information, refer to the [Firecrawl MCP server README](https://github.com/firecrawl/firecrawl-mcp-server).*