# Firecrawl MCP Installation Guide

[Firecrawl](https://firecrawl.dev) is a powerful web-ready scraper and crawler for LLMs. The [Model Context Protocol (MCP)](https://modelcontextprotocol.io) integration allows any compatible AI agent or IDE to scrape and crawl the web using Firecrawl's industry-leading technology.

This guide provides step-by-step installation instructions for 20+ MCP-compatible environments.

## Prerequisites

- **Firecrawl API Key**: Get your free API key at [firecrawl.dev](https://firecrawl.dev).
- **Node.js**: Ensure Node.js (v18+) and npm are installed on your machine.
- **Firecrawl MCP Server**: The server is available on npm as `@firecrawl/mcp-server`.

---

## Installation by Environment

Choose your preferred environment below for specific configuration instructions.

<details>
<summary><b>1. Claude Desktop (macOS)</b></summary>

1. Open your Claude Desktop configuration file:
   `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Add the following to the `mcpServers` object:
```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  }
}
```
3. Restart Claude Desktop.
</details>

<details>
<summary><b>2. Claude Desktop (Windows)</b></summary>

1. Open your Claude Desktop configuration file:
   `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the following to the `mcpServers` object:
```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  }
}
```
3. Restart Claude Desktop.
</details>

<details>
<summary><b>3. Cursor</b></summary>

1. **One-Click Install**: Click the button below to instantly install Firecrawl in Cursor:
   [![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=Firecrawl&config=eyJjb21tYW5kIjogIm5weCIsICJhcmdzIjogWyIteSIsICJAZmlyZWNyYXdsL21jcC1zZXJ2ZXIiXSwgImVudiI6IHsiRklSRUNSQVdMX0FQSV9LRVkiOiAiWU9VUl9GSUlSRUNSQVdMX0FQSV9LRVkiIn19)

2. **Manual Install**: Open Cursor and go to **Settings** -> **Features** -> **MCP**.
3. Click **Add New MCP Server**.
4. Fill in the details:
   - **Name**: `Firecrawl`
   - **Type**: `command`
   - **Command**: `npx -y @firecrawl/mcp-server`
5. Add the environment variable:
   - Click **Add Env** and add `FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY`.
6. Click **Save**.
</details>

<details>
<summary><b>4. Zed</b></summary>

1. Open your Zed settings (`Cmd+,` or `~/.config/zed/settings.json`).
2. Add the following under the `context_servers` key:
```json
{
  "context_servers": [
    {
      "name": "firecrawl",
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  ]
}
```
</details>

<details>
<summary><b>5. Claude Code</b></summary>

Run the following command in your terminal:
```bash
claude mcp add firecrawl npx -y @firecrawl/mcp-server --env FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY
```
</details>

<details>
<summary><b>6. Windsurf</b></summary>

1. Open your Windsurf MCP configuration file:
   `~/.codeium/windsurf/mcp_config.json`
2. Add the following to the `mcpServers` object:
```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary><b>7. Continue (VS Code)</b></summary>

1. Open your Continue configuration file (`~/.continue/config.json`).
2. Add the following to the `mcpServers` array:
```json
{
  "mcpServers": [
    {
      "name": "firecrawl",
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  ]
}
```
</details>

<details>
<summary><b>8. Aider</b></summary>

Run Aider with the following flag:
```bash
aider --mcp firecrawl:npx:-y:@firecrawl/mcp-server --env FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY
```
Or add it to your `.aider.conf.yml`:
```yaml
mcp:
  firecrawl: npx -y @firecrawl/mcp-server
env:
  FIRECRAWL_API_KEY: YOUR_FIRECRAWL_API_KEY
```
</details>

<details>
<summary><b>9. OpenClaw</b></summary>

Run the following command:
```bash
openclaw mcp add firecrawl --command "npx -y @firecrawl/mcp-server" --env FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY
```
</details>

<details>
<summary><b>10. Goose CLI</b></summary>

Run the following command:
```bash
goose mcp add firecrawl --command npx --args "-y,@firecrawl/mcp-server" --env FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY
```
</details>

<details>
<summary><b>11. Cline (VS Code)</b></summary>

1. Open Cline in VS Code.
2. Click the **Settings (gear icon)** -> **MCP Settings**.
3. Add the following JSON:
```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary><b>12. Roo Code (VS Code)</b></summary>

Follow the same steps as **Cline**. Roo Code uses a similar MCP settings structure.
</details>

<details>
<summary><b>13. Sourcegraph Cody</b></summary>

1. Open Cody Settings in your IDE.
2. Go to **MCP Servers** -> **Add**.
3. Use the following configuration:
```json
{
  "command": "npx",
  "args": ["-y", "@firecrawl/mcp-server"],
  "env": {
    "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
  }
}
```
</details>

<details>
<summary><b>14. PearAI</b></summary>

PearAI is based on Cursor. Go to **Settings** -> **Features** -> **MCP** and add the server as you would in Cursor.
</details>

<details>
<summary><b>15. Smithery</b></summary>

1. Create a `smithery.json` file in your project:
```json
{
  "servers": [
    {
      "name": "firecrawl",
      "command": "npx",
      "args": ["-y", "@firecrawl/mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"
      }
    }
  ]
}
```
2. Run `smithery up`.
</details>

<details>
<summary><b>16. MCP-Inspector</b></summary>

To test the server locally, run:
```bash
npx @modelcontextprotocol/inspector npx -y @firecrawl/mcp-server
```
Don't forget to set `FIRECRAWL_API_KEY` in your terminal environment before running.
</details>

<details>
<summary><b>17. MCP-Client (Node.js SDK)</b></summary>

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@firecrawl/mcp-server"],
  env: {
    ...process.env,
    FIRECRAWL_API_KEY: "YOUR_FIRECRAWL_API_KEY"
  }
});

const client = new Client({ name: "firecrawl-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
```
</details>

<details>
<summary><b>18. MCP-Client (Python SDK)</b></summary>

```python
import os
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def run():
    async with stdio_client(StdioServerParameters(
        command="npx",
        args=["-y", "@firecrawl/mcp-server"],
        env={"FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY", **os.environ}
    )) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            # Use session to call tools
            
asyncio.run(run())
```
</details>

<details>
<summary><b>19. Genkit (Firebase)</b></summary>

```typescript
import { mcp } from '@genkit-ai/mcp';

const firecrawlServer = mcp('firecrawl', {
  command: 'npx',
  args: ['-y', '@firecrawl/mcp-server'],
  env: { FIRECRAWL_API_KEY: 'YOUR_FIRECRAWL_API_KEY' }
});
```
</details>

<details>
<summary><b>20. LangChain (Python)</b></summary>

```python
from langchain_mcp import MCPTool

firecrawl_tool = MCPTool(
    name="firecrawl",
    command=["npx", "-y", "@firecrawl/mcp-server"],
    env={"FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"}
)
```
</details>

<details>
<summary><b>21. Supermaven</b></summary>

1. Open Supermaven Settings.
2. Go to the **MCP** section.
3. Add a new server with:
   - Command: `npx`
   - Args: `-y @firecrawl/mcp-server`
   - Env: `FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY`
</details>

<details>
<summary><b>22. LibreChat</b></summary>

1. Open your `librechat.yaml` configuration file.
2. Add the following to the `mcpServers` section:
```yaml
mcpServers:
  firecrawl:
    command: "npx"
    args: ["-y", "@firecrawl/mcp-server"]
    env:
      FIRECRAWL_API_KEY: "YOUR_FIRECRAWL_API_KEY"
```
3. Restart LibreChat.
</details>

<details>
<summary><b>23. Dify</b></summary>

1. Go to **Integrations** -> **MCP**.
2. Add a new server with:
   - Name: `Firecrawl`
   - Type: `command`
   - Command: `npx -y @firecrawl/mcp-server`
   - Env: `FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY`
</details>

<details>
<summary><b>24. Flowise</b></summary>

1. Use the **MCP Tool** in Flowise.
2. Configure the tool with:
   - Command: `npx`
   - Args: `["-y", "@firecrawl/mcp-server"]`
   - Env: `{"FIRECRAWL_API_KEY": "YOUR_FIRECRAWL_API_KEY"}`
</details>

<details>
<summary><b>25. Puter</b></summary>

1. Open Puter and use the MCP integration in the AI agent.
2. Configure with the command: `npx -y @firecrawl/mcp-server`.
</details>

---

## Verification

Once installed, you can verify the integration by asking your LLM:
> "Search for the latest news about Firecrawl using the firecrawl tool."

The LLM should invoke the `firecrawl_scrape` or `firecrawl_search` tool and provide the results.

## Troubleshooting

- **API Key Error**: Ensure `FIRECRAWL_API_KEY` is correctly set and active.
- **Node.js Path**: Some environments (like Claude Desktop) may require the full path to `node` or `npx`. Use `which npx` to find the path and replace `npx` with the full path if needed.
- **Logs**: Check the logs of your MCP client for detailed error messages from the Firecrawl MCP server.

## Official Resources

- [Firecrawl MCP Server GitHub](https://github.com/firecrawl/firecrawl-mcp-server)
- [Firecrawl Documentation](https://docs.firecrawl.dev)
- [MCP Official Website](https://modelcontextprotocol.io)
