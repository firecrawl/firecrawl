# Firecrawl MCP Installation Guide

This guide provides comprehensive installation instructions for integrating Firecrawl with all major MCP (Model Context Protocol) compatible environments.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Environment-Specific Installation](#environment-specific-installation)
  - [Cursor](#cursor)
  - [VS Code](#vs-code)
  - [Claude Desktop](#claude-desktop)
  - [JetBrains IDEs](#jetbrains-ides)
  - [Zed](#zed)
  - [Emacs](#emacs)
  - [Vim/Neovim](#vimneovim)
  - [Sublime Text](#sublime-text)
  - [Atom](#atom)
  - [CodeSandbox](#codesandbox)
  - [GitHub Codespaces](#github-codespaces)
  - [Replit](#replit)
  - [Jupyter Notebooks](#jupyter-notebooks)
  - [Google Colab](#google-colab)
  - [Docker Environments](#docker-environments)
  - [Terminal/CLI](#terminalcli)
  - [Browser-based Editors](#browser-based-editors)
  - [CI/CD Environments](#cicd-environments)
  - [Smithery](#smithery)
  - [Continue.dev](#continuedev)
  - [Windsurf](#windsurf)
  - [Trae](#trae)
  - [OpenAI Codex](#openai-codex)

## Overview

Firecrawl MCP server enables AI assistants to interact with web content through the Model Context Protocol. This allows seamless integration with various development environments and AI tools.

### What is MCP?

The Model Context Protocol (MCP) is an open protocol that enables AI models to securely interact with external data sources and tools. Firecrawl's MCP server implementation allows AI assistants to:

- Scrape web content and convert it to markdown
- Crawl websites and extract structured data
- Perform web searches and retrieve results
- Extract specific information from web pages

## Prerequisites

Before installing Firecrawl MCP, ensure you have:

1. **API Key**: Obtain a Firecrawl API key from [firecrawl.dev](https://firecrawl.dev)
2. **Node.js**: Version 16 or higher (for running the MCP server)
3. **Package Manager**: npm, yarn, or pnpm
4. **Compatible Environment**: One of the supported MCP environments listed below

## Environment-Specific Installation

### Cursor

**Prerequisites:**
- Cursor IDE installed
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP Package:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure Cursor MCP Settings:**
Open Cursor settings and add the following configuration to your MCP servers:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. **Verification:**
- Restart Cursor
- Open any file and trigger MCP tools
- Verify Firecrawl tools appear in available tools

### VS Code

**Prerequisites:**
- VS Code installed
- VS Code MCP extension
- Node.js 16+

**Installation Steps:**

1. **Install VS Code MCP Extension:**
```bash
code --install-extension microsoft.mcp
```

2. **Install Firecrawl MCP Package:**
```bash
npm install -g @firecrawl/mcp-server
```

3. **Configure VS Code Settings:**
Add to your VS Code settings.json:

```json
{
  "mcp.servers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

4. **Verification:**
- Restart VS Code
- Check MCP output panel for server status
- Test Firecrawl tools in any file

### Claude Desktop

**Prerequisites:**
- Claude Desktop app installed
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP Package:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure Claude Desktop:**
Edit Claude's configuration file (usually located at `~/.claude/config.json`):

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. **Verification:**
- Restart Claude Desktop
- Start a new conversation
- Verify Firecrawl tools are available in tool selection

### JetBrains IDEs

**Prerequisites:**
- IntelliJ IDEA, PyCharm, WebStorm, or other JetBrains IDE
- MCP plugin for JetBrains (if available)
- Node.js 16+

**Installation Steps:**

1. **Install JetBrains MCP Plugin:**
- Open IDE Settings
- Go to Plugins
- Search for and install MCP plugin

2. **Install Firecrawl MCP Package:**
```bash
npm install -g @firecrawl/mcp-server
```

3. **Configure IDE:**
Add MCP server configuration in IDE settings:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

4. **Verification:**
- Restart IDE
- Check MCP status in plugin panel
- Test Firecrawl integration

### Zed

**Prerequisites:**
- Zed editor installed
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP Package:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure Zed Settings:**
Add to your Zed settings.json:

```json
{
  "mcp_servers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. **Verification:**
- Restart Zed
- Open command palette and search for MCP
- Verify Firecrawl server is running

### Emacs

**Prerequisites:**
- Emacs 27+
- Node.js 16+
- Optional: emacs-mcp package

**Installation Steps:**

1. **Install emacs-mcp package (optional):**
```elisp
(use-package mcp
  :ensure t
  :config
  (mcp-register-server
   "firecrawl"
   '((:command . "node")
     (:args . ("/path/to/firecrawl-mcp-server"))
     (:env . (("FIRECRAWL_API_KEY" . "your-api-key-here"))))))
```

2. **Manual Configuration:**
Add to your .emacs file:

```elisp
(require 'mcp)
(mcp-add-server
 "firecrawl"
 '((command . "node")
   (args . ("/path/to/firecrawl-mcp-server"))
   (env . (("FIRECRAWL_API_KEY" . "your-api-key-here")))))
```

3. **Verification:**
- Restart Emacs
- Run `M-x mcp-list-servers`
- Verify Firecrawl server appears in list

### Vim/Neovim

**Prerequisites:**
- Vim 8+ or Neovim 0.5+
- Node.js 16+
- Optional: vim-mcp or nvim-mcp plugin

**Installation Steps:**

1. **Install vim-mcp plugin:**
```vim
Plug 'your-username/vim-mcp'
```

2. **Configure in vimrc:**
```vim
let g:mcp_servers = {
  \ 'firecrawl': {
  \   'command': 'node',
  \   'args': ['/path/to/firecrawl-mcp-server'],
  \   'env': {'FIRECRAWL_API_KEY': 'your-api-key-here'}
  \ }
\ }
```

3. **Verification:**
- Restart Vim/Neovim
- Run `:MCPListServers`
- Verify Firecrawl server is listed

### Sublime Text

**Prerequisites:**
- Sublime Text 3 or 4
- Node.js 16+
- Package Control

**Installation Steps:**

1. **Install via Package Control:**
- Open Command Palette
- Search for "MCP Server"
- Install MCP Server package

2. **Configure MCP Settings:**
Create or edit MCP configuration in Sublime settings:

```json
{
  "mcp_servers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. **Verification:**
- Restart Sublime Text
- Check MCP panel for server status
- Test Firecrawl tools

### Atom

**Prerequisites:**
- Atom editor
- Node.js 16+
- atom-mcp package

**Installation Steps:**

1. **Install atom-mcp package:**
```bash
apm install atom-mcp
```

2. **Configure in Atom settings:**
Add MCP server configuration:

```json
{
  "mcp": {
    "servers": {
      "firecrawl": {
        "command": "node",
        "args": ["/path/to/firecrawl-mcp-server"],
        "env": {
          "FIRECRAWL_API_KEY": "your-api-key-here"
        }
      }
    }
  }
}
```

3. **Verification:**
- Restart Atom
- Check MCP package status
- Verify Firecrawl integration

### CodeSandbox

**Prerequisites:**
- CodeSandbox account
- Node.js 16+

**Installation Steps:**

1. **Create new sandbox:**
- Go to codesandbox.io
- Create new Node.js sandbox

2. **Install dependencies:**
```bash
npm install @firecrawl/mcp-server
```

3. **Configure sandbox:**
Add MCP configuration to package.json or create .mcp.json:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["./node_modules/.bin/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

4. **Verification:**
- Run sandbox
- Check console for MCP server logs
- Test Firecrawl tools in editor

### GitHub Codespaces

**Prerequisites:**
- GitHub repository with Codespaces enabled
- Node.js 16+

**Installation Steps:**

1. **Configure devcontainer:**
Add to .devcontainer/devcontainer.json:

```json
{
  "postCreateCommand": "npm install -g @firecrawl/mcp-server",
  "customizations": {
    "vscode": {
      "settings": {
        "mcp.servers": {
          "firecrawl": {
            "command": "node",
            "args": ["/usr/local/bin/firecrawl-mcp-server"],
            "env": {
              "FIRECRAWL_API_KEY": "${localEnv:FIRECRAWL_API_KEY}"
            }
          }
        }
      }
    }
  }
}
```

2. **Set environment variable:**
- Go to repository Settings > Secrets
- Add FIRECRAWL_API_KEY secret

3. **Verification:**
- Open Codespace
- Check VS Code MCP extension
- Verify Firecrawl server status

### Replit

**Prerequisites:**
- Replit account
- Node.js 16+

**Installation Steps:**

1. **Create Repl:**
- Go to replit.com
- Create new Node.js Repl

2. **Install package:**
```bash
npm install @firecrawl/mcp-server
```

3. **Configure Replit:**
Add to .replit file:

```nix
[env]
FIRECRAWL_API_KEY = "your-api-key-here"

[packages]
nodejs = "16"
```

4. **Add MCP configuration:**
Create .mcp.json in Repl:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["./node_modules/.bin/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

5. **Verification:**
- Run Repl
- Check console output
- Test Firecrawl tools

### Jupyter Notebooks

**Prerequisites:**
- Jupyter installed
- Node.js 16+
- jupyter-mcp extension

**Installation Steps:**

1. **Install jupyter-mcp:**
```bash
pip install jupyter-mcp
```

2. **Install Firecrawl MCP:**
```bash
npm install -g @firecrawl/mcp-server
```

3. **Configure Jupyter:**
Add to jupyter configuration:

```python
c.NotebookApp.mcp_servers = {
    'firecrawl': {
        'command': 'node',
        'args': ['/path/to/firecrawl-mcp-server'],
        'env': {'FIRECRAWL_API_KEY': 'your-api-key-here'}
    }
}
```

4. **Verification:**
- Start Jupyter server
- Create new notebook
- Check MCP kernel options

### Google Colab

**Prerequisites:**
- Google Colab environment
- Node.js runtime

**Installation Steps:**

1. **Install in Colab cell:**
```python
!npm install -g @firecrawl/mcp-server
```

2. **Configure environment:**
```python
import os
os.environ['FIRECRAWL_API_KEY'] = 'your-api-key-here'

# Start MCP server
import subprocess
subprocess.Popen(['node', '/usr/local/bin/firecrawl-mcp-server'])
```

3. **Verification:**
- Run setup cell
- Check if MCP server starts successfully
- Test Firecrawl integration

### Docker Environments

**Prerequisites:**
- Docker installed
- Docker Compose (optional)

**Installation Steps:**

1. **Create Dockerfile:**
```dockerfile
FROM node:16-alpine

RUN npm install -g @firecrawl/mcp-server

ENV FIRECRAWL_API_KEY=your-api-key-here

CMD ["node", "/usr/local/bin/firecrawl-mcp-server"]
```

2. **Build and run:**
```bash
docker build -t firecrawl-mcp .
docker run -e FIRECRAWL_API_KEY=your-key firecrawl-mcp
```

3. **Docker Compose:**
```yaml
version: '3.8'
services:
  firecrawl-mcp:
    build: .
    environment:
      - FIRECRAWL_API_KEY=your-api-key-here
    restart: unless-stopped
```

4. **Verification:**
- Check Docker logs
- Verify MCP server is running
- Test integration with host environment

### Terminal/CLI

**Prerequisites:**
- Terminal/CLI environment
- Node.js 16+

**Installation Steps:**

1. **Install globally:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Run MCP server:**
```bash
FIRECRAWL_API_KEY=your-api-key node /usr/local/bin/firecrawl-mcp-server
```

3. **Verification:**
- Check if server starts without errors
- Verify port is listening (usually 3000)
- Test MCP client connection

### Browser-based Editors

**Prerequisites:**
- Modern web browser
- Browser-based editor (Monaco, CodeMirror, etc.)

**Installation Steps:**

1. **Include MCP client library:**
```html
<script src="https://cdn.jsdelivr.net/npm/mcp-client@latest/dist/mcp-client.js"></script>
```

2. **Configure MCP connection:**
```javascript
const client = new MCP.Client();
await client.connect({
  server: 'ws://localhost:3000',
  apiKey: 'your-api-key-here'
});
```

3. **Verification:**
- Open browser editor
- Check console for connection status
- Test Firecrawl tools

### CI/CD Environments

**Prerequisites:**
- CI/CD platform (GitHub Actions, Jenkins, etc.)
- Node.js 16+

**Installation Steps:**

1. **GitHub Actions example:**
```yaml
- name: Setup Firecrawl MCP
  run: |
    npm install -g @firecrawl/mcp-server
    nohup node /usr/local/bin/firecrawl-mcp-server &
```

2. **Environment variables:**
```yaml
env:
  FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}
```

3. **Verification:**
- Check action logs
- Verify MCP server starts successfully
- Test integration in CI environment

### Smithery

**Prerequisites:**
- Smithery CLI installed
- Node.js 16+

**Installation Steps:**

1. **Install Smithery:**
```bash
npm install -g smithery
```

2. **Install Firecrawl via Smithery:**
```bash
smithery install @firecrawl/mcp-server
```

3. **Configure Smithery:**
```bash
smithery configure firecrawl --api-key your-api-key-here
```

4. **Verification:**
- Run `smithery status`
- Verify Firecrawl server is registered
- Test integration

### Continue.dev

**Prerequisites:**
- Continue.dev installed
- Node.js 16+

**Installation Steps:**

1. **Configure Continue.dev:**
Add to continue config:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

2. **Verification:**
- Restart Continue.dev
- Check server status
- Test Firecrawl tools

### Windsurf

**Prerequisites:**
- Windsurf IDE installed
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure Windsurf:**
Add MCP configuration to settings:

```json
{
  "mcp": {
    "servers": {
      "firecrawl": {
        "command": "node",
        "args": ["/path/to/firecrawl-mcp-server"],
        "env": {
          "FIRECRAWL_API_KEY": "your-api-key-here"
        }
      }
    }
  }
}
```

3. **Verification:**
- Restart Windsurf
- Check MCP status panel
- Test Firecrawl integration

### Trae

**Prerequisites:**
- Trae IDE installed
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure Trae:**
Add to Trae configuration:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "node",
      "args": ["/path/to/firecrawl-mcp-server"],
      "env": {
        "FIRECRAWL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

3. **Verification:**
- Restart Trae
- Check MCP configuration
- Test Firecrawl tools

### OpenAI Codex

**Prerequisites:**
- OpenAI API access
- Node.js 16+

**Installation Steps:**

1. **Install Firecrawl MCP:**
```bash
npm install -g @firecrawl/mcp-server
```

2. **Configure OpenAI integration:**
```python
import openai
from mcp.client import MCPClient

# Setup MCP client
client = MCPClient()
await client.connect('ws://localhost:3000')

# Use with OpenAI
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Use Firecrawl to scrape https://example.com"}],
    functions=client.get_tools()
)
```

3. **Verification:**
- Run MCP server
- Test OpenAI integration
- Verify tool calls work correctly

## Troubleshooting

### Common Issues

1. **Server won't start:**
   - Check Node.js version (16+ required)
   - Verify API key is correct
   - Check port availability

2. **Environment not detecting server:**
   - Ensure correct paths in configuration
   - Check environment variables
   - Restart environment after configuration

3. **Permission errors:**
   - Check file permissions for MCP server
   - Ensure user has access to API key
   - Verify network connectivity

### Getting Help

- Check the [Firecrawl Documentation](https://docs.firecrawl.dev)
- Join our [Discord community](https://discord.gg/firecrawl)
- Open an issue on [GitHub](https://github.com/firecrawl/firecrawl-mcp-server/issues)

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on how to help improve these installation instructions.

---

**Note:** This documentation is maintained by the Firecrawl community. For the most up-to-date information, please refer to the [official Firecrawl MCP repository](https://github.com/firecrawl/firecrawl-mcp-server).
