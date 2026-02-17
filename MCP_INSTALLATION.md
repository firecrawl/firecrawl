<div align="center">
  <img
    src="https://raw.githubusercontent.com/firecrawl/firecrawl-mcp-server/main/img/fire.png"
    height="100"
  >
  <h1>Firecrawl MCP Server - Installation Guide</h1>
  <p>Comprehensive installation instructions for all MCP-compatible environments</p>
</div>

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [IDE & Editor Integrations](#ide--editor-integrations)
  - [Cursor](#cursor)
  - [VS Code (GitHub Copilot)](#vs-code-github-copilot)
  - [Windsurf](#windsurf)
  - [Zed](#zed)
  - [JetBrains AI Assistant](#jetbrains-ai-assistant)
  - [Visual Studio 2022](#visual-studio-2022)
  - [Trae](#trae)
- [AI Coding Assistants](#ai-coding-assistants)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code)
  - [Cline](#cline)
  - [Roo Code](#roo-code)
  - [Kilo Code](#kilo-code)
  - [Augment Code](#augment-code)
  - [Kiro](#kiro)
  - [Qwen Code](#qwen-code)
- [CLI Tools](#cli-tools)
  - [GitHub Copilot CLI](#github-copilot-cli)
  - [GitHub Copilot Coding Agent](#github-copilot-coding-agent)
  - [Amazon Q Developer CLI](#amazon-q-developer-cli)
  - [Gemini CLI](#gemini-cli)
  - [Amp](#amp)
  - [Warp](#warp)
  - [Rovo Dev CLI](#rovo-dev-cli)
- [Other Platforms](#other-platforms)
  - [OpenAI Codex](#openai-codex)
  - [Google Antigravity](#google-antigravity)
  - [Opencode](#opencode)
  - [LM Studio](#lm-studio)
  - [BoltAI](#boltai)
  - [Perplexity Desktop](#perplexity-desktop)
  - [Zencoder](#zencoder)
  - [Qodo Gen](#qodo-gen)
  - [Crush](#crush)
  - [Emdash](#emdash)
  - [Desktop Extension](#desktop-extension)
  - [Smithery](#smithery)
- [Alternative Runtimes](#alternative-runtimes)
  - [Docker](#docker)
  - [Bun](#bun)
  - [Deno](#deno)
- [Platform-Specific Notes](#platform-specific-notes)
  - [Windows](#windows)
  - [Streamable HTTP (Local Mode)](#streamable-http-local-mode)
- [Self-Hosted Configuration](#self-hosted-configuration)
- [Environment Variables Reference](#environment-variables-reference)
- [Verification & Troubleshooting](#verification--troubleshooting)

---

## Prerequisites

Before installing the Firecrawl MCP server in any environment, ensure you have:

1. **Node.js** version 18 or higher installed ([download here](https://nodejs.org/))
2. **A Firecrawl API key** from [firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys) (free tier available)
3. **npx** available in your terminal (comes bundled with Node.js)

Verify your setup:

```bash
node --version   # Should be v18.0.0 or higher
npx --version    # Should be available
```

---

## Quick Start

The fastest way to run the Firecrawl MCP server:

```bash
env FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

Or install globally:

```bash
npm install -g firecrawl-mcp
```

Most MCP clients use a JSON configuration block like this:

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

Replace `YOUR_API_KEY` with your actual Firecrawl API key throughout this guide.

---

## IDE & Editor Integrations

### Cursor

> Requires Cursor version 0.45.6 or higher. See [Cursor MCP Configuration Guide](https://docs.cursor.com/context/model-context-protocol#configuring-mcp-servers).

#### Cursor v0.48.6+

1. Open **Cursor Settings**
2. Go to **Features > MCP Servers**
3. Click **"+ Add new global MCP server"**
4. Enter the following configuration:

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

Alternatively, add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-specific).

#### Cursor v0.45.6

1. Open **Cursor Settings**
2. Go to **Features > MCP Servers**
3. Click **"+ Add New MCP Server"**
4. Enter the following:
   - **Name:** `firecrawl-mcp`
   - **Type:** `command`
   - **Command:** `env FIRECRAWL_API_KEY=YOUR_API_KEY npx -y firecrawl-mcp`

> **Windows users:** Use `cmd /c "set FIRECRAWL_API_KEY=YOUR_API_KEY && npx -y firecrawl-mcp"` instead.

After adding, refresh the MCP server list to see the new tools. The Composer Agent will automatically use Firecrawl MCP when appropriate. Access the Composer via `Cmd+L` (Mac) or `Ctrl+L` (Windows/Linux), select "Agent" next to the submit button, and enter your query.

---

### VS Code (GitHub Copilot)

> Requires VS Code with GitHub Copilot extension. See [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

#### One-Click Installation

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=firecrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Firecrawl%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22firecrawl-mcp%22%5D%2C%22env%22%3A%7B%22FIRECRAWL_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=firecrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Firecrawl%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22firecrawl-mcp%22%5D%2C%22env%22%3A%7B%22FIRECRAWL_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D&quality=insiders)

#### Manual Installation (User Settings)

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type **"Preferences: Open User Settings (JSON)"**
3. Add the following configuration:

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

#### Project-Level Configuration

Create a `.vscode/mcp.json` file in your workspace root to share the configuration with your team:

```json
{
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
```

---

### Windsurf

> See [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/mcp) for more details.

Add this to your `~/.codeium/windsurf/model_config.json`:

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

---

### Zed

> See [Zed Context Server docs](https://zed.dev/docs/assistant/context-servers) for more details.

Add this to your Zed `settings.json` (accessible via `Zed > Settings > Open Settings`):

```json
{
  "context_servers": {
    "firecrawl-mcp": {
      "command": {
        "path": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": {
          "FIRECRAWL_API_KEY": "YOUR_API_KEY"
        }
      }
    }
  }
}
```

---

### JetBrains AI Assistant

> Works with IntelliJ IDEA, WebStorm, PyCharm, and other JetBrains IDEs. See [JetBrains AI Assistant MCP docs](https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html).

1. Go to **Settings > Tools > AI Assistant > Model Context Protocol (MCP)**
2. Click **+ Add**
3. Click **Command** in the top-left corner and select **As JSON**
4. Add the following configuration:

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

5. Click **Apply** to save.

---

### Visual Studio 2022

> Requires Visual Studio 2022 17.14 Preview 3 or later with GitHub Copilot. See [Visual Studio MCP docs](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers).

1. Go to **Tools > Options > GitHub Copilot > MCP Servers**
2. Click **Add Server**
3. Choose **stdio** transport
4. Add the following configuration:

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

Alternatively, create a `.github/mcp.json` in your repository root for team-wide configuration.

---

### Trae

> See [Trae MCP documentation](https://docs.trae.ai/ide/model-context-protocol) for more details.

1. Open Trae
2. Navigate to **MCP Servers** settings
3. Use the **Add manually** option
4. Paste the following configuration:

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

---

## AI Coding Assistants

### Claude Desktop

> See [Claude Desktop MCP docs](https://modelcontextprotocol.io/quickstart/user) for more details.

Add this to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

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

**With optional retry and credit monitoring configuration:**

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY",
        "FIRECRAWL_RETRY_MAX_ATTEMPTS": "5",
        "FIRECRAWL_RETRY_INITIAL_DELAY": "2000",
        "FIRECRAWL_RETRY_MAX_DELAY": "30000",
        "FIRECRAWL_RETRY_BACKOFF_FACTOR": "3",
        "FIRECRAWL_CREDIT_WARNING_THRESHOLD": "2000",
        "FIRECRAWL_CREDIT_CRITICAL_THRESHOLD": "500"
      }
    }
  }
}
```

After saving, restart Claude Desktop. You should see the Firecrawl tools available in the tools menu (hammer icon).

---

### Claude Code

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is Anthropic's CLI coding tool with native MCP support.

#### Quick Setup

```bash
claude mcp add firecrawl-mcp -e FIRECRAWL_API_KEY=YOUR_API_KEY -- npx -y firecrawl-mcp
```

#### Scope Options

```bash
# Project-level (saved in .mcp.json in the current project)
claude mcp add firecrawl-mcp -s project -e FIRECRAWL_API_KEY=YOUR_API_KEY -- npx -y firecrawl-mcp

# User-level (available across all projects)
claude mcp add firecrawl-mcp -s user -e FIRECRAWL_API_KEY=YOUR_API_KEY -- npx -y firecrawl-mcp
```

#### Self-Hosted Instance

```bash
claude mcp add firecrawl-mcp \
  -e FIRECRAWL_API_URL=https://firecrawl.your-domain.com \
  -- npx -y firecrawl-mcp
```

#### Streamable HTTP Transport

```bash
claude mcp add firecrawl-mcp --transport http http://localhost:3000/mcp
```

#### Verify Installation

```bash
claude mcp list
```

You should see `firecrawl-mcp` listed with its available tools.

---

### Cline

> See [Cline MCP docs](https://docs.cline.bot/mcp-servers/configuring-mcp-servers) for more details.

#### Install from Marketplace

1. Open Cline in VS Code
2. Click the hamburger menu, then **MCP Servers**
3. Go to the **Marketplace** tab
4. Search for **"Firecrawl"**
5. Click **Install**

#### Manual Configuration

1. Open Cline, click the hamburger menu, then **MCP Servers**
2. Go to the **Installed** tab
3. Click **Edit Configuration**
4. Add to `mcpServers`:

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

---

### Roo Code

> See [Roo Code MCP docs](https://docs.roocode.com/features/mcp/using-mcp-in-roo) for more details.

Add this to your Roo Code MCP configuration:

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

You can also configure via the Roo Code UI:
1. Open Roo Code settings
2. Navigate to **MCP Servers**
3. Click **Edit MCP Settings**
4. Add the configuration above

---

### Kilo Code

> See [Kilo Code MCP docs](https://kilocode.ai/docs/features/mcp) for more details.

#### Via UI

1. Open Kilo Code, then click **Settings** (top-right gear icon)
2. Navigate to **Settings > MCP Servers**
3. Click **Add Server**
4. Enter the server details

#### Manual Configuration

Create `.kilocode/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      },
      "disabled": false
    }
  }
}
```

---

### Augment Code

> See [Augment Code MCP docs](https://docs.augmentcode.com/setup-augment/mcp) for more details.

#### Via UI

1. Click the hamburger menu, then **Settings**
2. Navigate to the **Tools** section
3. Click **+ Add MCP**
4. Enter:
   - **Command:** `npx -y firecrawl-mcp`
   - **Name:** `firecrawl-mcp`
5. Click **Add**

#### Manual Configuration

Add to the `augment.advanced` object in your VS Code `settings.json`:

```json
{
  "augment.advanced": {
    "mcpServers": [
      {
        "name": "firecrawl-mcp",
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": {
          "FIRECRAWL_API_KEY": "YOUR_API_KEY"
        }
      }
    ]
  }
}
```

---

### Kiro

> See [Kiro MCP Documentation](https://kiro.dev/docs/mcp/configuration/) for details.

1. Navigate to **Kiro > MCP Servers**
2. Click the **+ Add** button
3. Paste the following configuration:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

4. Click **Save** to apply.

---

### Qwen Code

> See [Qwen Code MCP Configuration](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/) for details.

#### Using CLI

```bash
qwen mcp add firecrawl-mcp npx -y firecrawl-mcp
```

Use `--scope user` for user-level configuration:

```bash
qwen mcp add --scope user firecrawl-mcp npx -y firecrawl-mcp
```

#### Manual Configuration

Add to `~/.qwen/settings.json` or `.qwen/settings.json` (project-level):

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

---

## CLI Tools

### GitHub Copilot CLI

> See [GitHub Copilot CLI docs](https://docs.github.com/en/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/managing-copilot-policies-as-an-individual-subscriber) for more details.

Add this to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

---

### GitHub Copilot Coding Agent

> See [GitHub Copilot Coding Agent MCP docs](https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-coding-agent-with-mcp) for more details.

Add to your repository settings under **Settings > Copilot > Coding agent > MCP configuration**, or create a `.github/copilot/mcp.json` file in your repository:

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

> **Note:** For the Coding Agent, it is recommended to store your API key as a repository secret and reference it via `${{ secrets.FIRECRAWL_API_KEY }}`.

---

### Amazon Q Developer CLI

> See [Amazon Q Developer CLI MCP docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-configuration.html) for more details.

Add this to your Amazon Q Developer CLI MCP configuration file at `~/.aws/amazonq/mcp.json`:

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

---

### Gemini CLI

> See [Gemini CLI MCP Configuration](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html) for details.

Add this to `~/.gemini/settings.json`:

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

---

### Amp

> See [Amp MCP docs](https://ampcode.com/docs/customize/mcp-servers) for more details.

```bash
amp mcp add firecrawl-mcp -- npx -y firecrawl-mcp
```

Then set the `FIRECRAWL_API_KEY` environment variable in your shell profile (e.g., `~/.bashrc`, `~/.zshrc`):

```bash
export FIRECRAWL_API_KEY=YOUR_API_KEY
```

---

### Warp

> See [Warp MCP Documentation](https://docs.warp.dev/knowledge-and-collaboration/mcp#adding-an-mcp-server) for details.

1. Navigate to **Settings > AI > Manage MCP servers**
2. Click the **+ Add** button
3. Paste the following configuration:

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

> **Note:** Warp uses a slightly different config format without the wrapping `mcpServers` key.

---

### Rovo Dev CLI

> See [Rovo Dev CLI docs](https://developer.atlassian.com/cloud/rovo/dev-cli/) for details.

Add to your Rovo Dev CLI configuration:

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

---

## Other Platforms

### OpenAI Codex

> See [OpenAI Codex](https://github.com/openai/codex) for details.

Add this to your Codex configuration file (`codex.toml` or similar):

```toml
[mcp_servers.firecrawl-mcp]
command = "npx"
args = ["-y", "firecrawl-mcp"]

[mcp_servers.firecrawl-mcp.env]
FIRECRAWL_API_KEY = "YOUR_API_KEY"
```

If you encounter startup timeout errors, increase `startup_timeout_ms`:

```toml
[mcp_servers.firecrawl-mcp]
command = "npx"
args = ["-y", "firecrawl-mcp"]
startup_timeout_ms = 40_000

[mcp_servers.firecrawl-mcp.env]
FIRECRAWL_API_KEY = "YOUR_API_KEY"
```

---

### Google Antigravity

> See [Google Antigravity MCP docs](https://developers.google.com/gemini/antigravity/mcp) for details.

Add to your Antigravity MCP configuration file:

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

---

### Opencode

> See [Opencode MCP docs](https://opencode.ai/docs/mcp-servers) for details.

Add to your Opencode configuration file:

```json
{
  "mcp": {
    "firecrawl-mcp": {
      "type": "local",
      "command": ["npx", "-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      },
      "enabled": true
    }
  }
}
```

> **Note:** Opencode uses a different configuration format with the `mcp` key instead of `mcpServers`, and accepts the command as an array.

---

### LM Studio

> See [LM Studio MCP docs](https://lmstudio.ai/docs/advanced/mcp) for details.

1. Open LM Studio
2. Go to **Settings > MCP Servers**
3. Click **Add Server**
4. Use the following configuration:

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

---

### BoltAI

> See [BoltAI MCP docs](https://docs.boltai.com/docs/mcp) for details.

1. Open BoltAI settings
2. Navigate to **Plugins > MCP Servers**
3. Click **Add Server** and configure:

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

---

### Perplexity Desktop

> See [Perplexity Desktop docs](https://www.perplexity.ai/hub/faq/mcp-support-in-perplexity) for details.

1. Open **Perplexity Desktop**
2. Go to **Settings > MCP Servers**
3. Add a new server with the following configuration:

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

---

### Zencoder

> See [Zencoder MCP docs](https://docs.zencoder.ai/features/mcp-integration) for details.

1. Open Zencoder settings
2. Navigate to **MCP Servers**
3. Add the following configuration:

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

---

### Qodo Gen

> See [Qodo Gen docs](https://docs.qodo.ai/qodo-gen/qodo-gen-chat/mcp) for details.

Add to the Qodo Gen MCP configuration:

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

---

### Crush

> See [Crush MCP docs](https://docs.crush.bot/user-guide/mcp-servers) for details.

Add to your Crush configuration:

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

---

### Emdash

> See [Emdash MCP docs](https://emdash.ai/docs/mcp-servers) for details.

Add to your Emdash MCP configuration:

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

---

### Desktop Extension

> See [Desktop Extension MCP docs](https://desktopextension.com/docs/mcp) for details.

Add to your Desktop Extension configuration:

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

---

### Smithery

> Install via [Smithery](https://smithery.ai/server/@mendableai/mcp-server-firecrawl).

```bash
npx -y @smithery/cli install @mendableai/mcp-server-firecrawl --client claude
```

You can replace `claude` with your target client (e.g., `cursor`, `windsurf`).

---

## Alternative Runtimes

### Docker

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
RUN npm install -g firecrawl-mcp
CMD ["firecrawl-mcp"]
```

Build the image:

```bash
docker build -t firecrawl-mcp .
```

Then use it in any MCP client configuration:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "FIRECRAWL_API_KEY=YOUR_API_KEY",
        "firecrawl-mcp"
      ],
      "transportType": "stdio"
    }
  }
}
```

For self-hosted Firecrawl instances:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "FIRECRAWL_API_KEY=YOUR_API_KEY",
        "-e", "FIRECRAWL_API_URL=https://firecrawl.your-domain.com",
        "firecrawl-mcp"
      ],
      "transportType": "stdio"
    }
  }
}
```

---

### Bun

Use `bunx` as a drop-in replacement for `npx` in any MCP client configuration:

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

---

### Deno

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "deno",
      "args": [
        "run",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "npm:firecrawl-mcp"
      ],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

---

## Platform-Specific Notes

### Windows

On Windows, `npx` may not work directly in some MCP clients. Use `cmd` or `powershell` as the command instead.

#### Using cmd

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

#### Using PowerShell

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

> **Tip:** If you encounter path issues on Windows, try using the full path to `npx` (e.g., `C:\Program Files\nodejs\npx.cmd`).

---

### Streamable HTTP (Local Mode)

To run the Firecrawl MCP server using Streamable HTTP transport instead of the default stdio:

```bash
env HTTP_STREAMABLE_SERVER=true FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

The server will start at `http://localhost:3000/mcp`. You can then configure any MCP client that supports HTTP transport to connect to this URL.

**Example for Claude Code:**

```bash
claude mcp add firecrawl-mcp --transport http http://localhost:3000/mcp
```

---

## Self-Hosted Configuration

If you are running a self-hosted Firecrawl instance, add the `FIRECRAWL_API_URL` environment variable to your configuration:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_URL": "https://firecrawl.your-domain.com",
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

> **Note:** When using a self-hosted instance, the API key is optional if your instance does not require authentication.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIRECRAWL_API_KEY` | Yes (cloud) | - | Your Firecrawl API key |
| `FIRECRAWL_API_URL` | No | Cloud API | Custom API endpoint for self-hosted instances |
| `FIRECRAWL_RETRY_MAX_ATTEMPTS` | No | `3` | Maximum number of retry attempts |
| `FIRECRAWL_RETRY_INITIAL_DELAY` | No | `1000` | Initial delay (ms) before first retry |
| `FIRECRAWL_RETRY_MAX_DELAY` | No | `10000` | Maximum delay (ms) between retries |
| `FIRECRAWL_RETRY_BACKOFF_FACTOR` | No | `2` | Exponential backoff multiplier |
| `FIRECRAWL_CREDIT_WARNING_THRESHOLD` | No | `1000` | Credit usage warning threshold |
| `FIRECRAWL_CREDIT_CRITICAL_THRESHOLD` | No | `100` | Credit usage critical threshold |
| `HTTP_STREAMABLE_SERVER` | No | `false` | Enable Streamable HTTP transport |

---

## Verification & Troubleshooting

### Verifying Your Installation

After configuring Firecrawl MCP in your environment, verify it is working:

1. **Check that the server starts:** Most MCP clients show a green indicator or list of available tools when the server is connected.
2. **Test with a simple query:** Ask your AI assistant to "scrape https://example.com" -- it should use the Firecrawl MCP tools.
3. **Check available tools:** The following tools should be available:
   - `firecrawl_scrape` - Scrape a single URL
   - `firecrawl_search` - Search the web
   - `firecrawl_crawl` - Crawl a website
   - `firecrawl_map` - Discover URLs on a site
   - `firecrawl_extract` - Extract structured data
   - `firecrawl_batch_scrape` - Scrape multiple URLs
   - `firecrawl_agent` - Autonomous web research
   - `firecrawl_browser_create` - Create browser sessions
   - `firecrawl_browser_execute` - Execute browser commands

### Common Issues

| Issue | Solution |
|-------|----------|
| `npx` not found | Ensure Node.js 18+ is installed and `npx` is in your PATH |
| Server timeout on startup | The first run downloads the package. Try increasing timeout or pre-install with `npm install -g firecrawl-mcp` |
| Authentication error | Verify your API key at [firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys) |
| Rate limit errors | The server handles retries automatically. Adjust retry settings via environment variables if needed |
| Windows path issues | Use `cmd` or `powershell` wrapper commands (see [Windows](#windows) section) |
| Tools not appearing | Restart your MCP client after adding the configuration |
| Permission denied | On Unix systems, ensure `npx` has execute permissions. Try `chmod +x $(which npx)` |

### Getting Help

- [Firecrawl Documentation](https://docs.firecrawl.dev)
- [Firecrawl MCP Server Repository](https://github.com/firecrawl/firecrawl-mcp-server)
- [Firecrawl Discord](https://discord.com/invite/gSmWdAkdwd)
- [GitHub Issues](https://github.com/mendableai/firecrawl/issues)
