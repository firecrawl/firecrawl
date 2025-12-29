# Firecrawl MCP Installation Instructions

This document provides detailed, step-by-step installation instructions for integrating the Firecrawl MCP server into various MCP-compatible environments. Firecrawl MCP enables web scraping, crawling, and search tools for AI-assisted workflows. 

Prerequisites for most setups include:
- A Firecrawl API key (sign up at https://firecrawl.dev/app).
- Node.js (version 16 or higher) and npm for local setups.
- Refer to individual sections for environment-specific requirements.

For the source repository, visit [firecrawl/firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server).

## Table of Contents

- [Install via Smithery](#install-via-smithery)
- [Install in Cursor](#install-in-cursor)
- [Install in Claude Code](#install-in-claude-code)
- [Install in Windsurf](#install-in-windsurf)
- [Install in VS Code](#install-in-vs-code)
- [Install in Cline](#install-in-cline)
- [Install in Zed](#install-in-zed)
- [Install in Augment Code](#install-in-augment-code)
- [Install in Roo Code](#install-in-roo-code)
- [Install in Gemini CLI](#install-in-gemini-cli)
- [Install in Claude Desktop](#install-in-claude-desktop)
- [Install in Opencode](#install-in-opencode)
- [Install in OpenAI Codex](#install-in-openai-codex)
- [Install in JetBrains AI Assistant](#install-in-jetbrains-ai-assistant)
- [Install in Kiro](#install-in-kiro)
- [Install in Trae](#install-in-trae)
- [Using Bun or Deno](#using-bun-or-deno)
- [Using Docker](#using-docker)
- [Install Using the Desktop Extension](#install-using-the-desktop-extension)
- [Install in Windows](#install-in-windows)
- [Install in Amazon Q Developer CLI](#install-in-amazon-q-developer-cli)
- [Install in Warp](#install-in-warp)
- [Install in Copilot Coding Agent](#install-in-copilot-coding-agent)
- [Install in Copilot CLI](#install-in-copilot-cli)
- [Install in LM Studio](#install-in-lm-studio)
- [Install in Visual Studio 2022](#install-in-visual-studio-2022)
- [Install in Crush](#install-in-crush)
- [Install in BoltAI](#install-in-boltai)
- [Install in Rovo Dev CLI](#install-in-rovo-dev-cli)
- [Install in Zencoder](#install-in-zencoder)
- [Install in Qodo Gen](#install-in-qodo-gen)
- [Install in Perplexity Desktop](#install-in-perplexity-desktop)
- [Install in Factory](#install-in-factory)
- [Install in Emdash](#install-in-emdash)

## Install via Smithery

Smithery is a legacy method for installing the Firecrawl MCP server, primarily used for automatic integration with compatible clients like Claude Desktop. It leverages the Smithery CLI to handle the installation and basic configuration.

### Prerequisites
- Node.js (version 16 or higher) and npm installed on your system. You can download them from the official Node.js website if needed.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to a compatible MCP client, such as Claude Desktop, for full integration.
- Terminal or command prompt access.

### Step-by-Step Installation
1. Open your terminal or command prompt.
2. Run the following command to install the Firecrawl MCP server via Smithery:
   ```
   npx -y @smithery/cli install @mendableai/mcp-server-firecrawl --client claude
   ```
   This command uses npx to execute the Smithery CLI without a global install, downloads the Firecrawl MCP package, and configures it for the specified client (e.g., Claude).

3. When prompted during the installation, enter your Firecrawl API key to configure the environment variable `FIRECRAWL_API_KEY`. This enables the MCP server to authenticate with Firecrawl's web scraping and search services.

4. If integrating with Claude Desktop (or another client), the command will automatically set up the necessary endpoints. For other clients, you may need to manually adjust configurations post-install (refer to your client's MCP documentation).

### Verification Steps
1. After installation, run the following command to start the MCP server locally for testing:
   ```
   npx @smithery/cli@latest run @mendableai/mcp-server-firecrawl --playground
   ```
   This launches a playground mode where you can test the server's functionality.

2. Open your MCP client (e.g., Claude Desktop) and check for the Firecrawl tools in the available integrations or extensions. If integrated correctly, you should see options for web scraping, crawling, or search actions.

3. Test a simple query in your client, such as scraping a webpage URL using Firecrawl commands. If the server responds with extracted content (e.g., markdown or data), the installation is successful.

4. If issues arise (e.g., API key errors), check the terminal logs for details and ensure your Firecrawl API key is valid and not rate-limited.

Note: As this is a legacy method, consider using modern alternatives like direct npx setups or Docker for newer environments if compatibility issues occur.

## Install in Cursor

Cursor is an AI-powered code editor that supports MCP (Model Context Protocol) servers for extending its capabilities with tools like web scraping and search via Firecrawl.

### Prerequisites
- Cursor IDE installed on your system (download from https://cursor.com if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Cursor's settings panel.
- Terminal access is optional but useful for troubleshooting.

### Step-by-Step Installation
1. Open Cursor Settings: Press `Cmd+,` on macOS or `Ctrl+,` on Windows/Linux to access the settings panel.

2. Search for "MCP": In the search bar within settings, type "MCP" to locate the MCP Servers configuration section. This is typically under Features > MCP Servers.

3. Add the Firecrawl MCP Configuration: Click "+ Add New MCP Server" or edit the existing MCP configuration JSON. Paste the following JSON block into the appropriate section (e.g., the user settings JSON or the dedicated MCP area):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key obtained from the dashboard.

4. Save the Changes: Ensure the JSON is valid and save the settings. If you encounter any errors, double-check the formatting.

### Verification Steps
1. Restart Cursor: Close and reopen the Cursor application to apply the changes.

2. Open Cursor Chat: Use `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) to open the chat interface.

3. Test with Sample Commands: Enter queries that utilize Firecrawl's tools to verify the integration:
   - Search Example: `Search for TypeScript best practices 2025`
   - Scrape Example: `Scrape firecrawl.dev and tell me what it does`
   - Get Docs Example: `Scrape the React hooks documentation and explain useEffect`

   Cursor should automatically invoke the Firecrawl MCP server and return results from web searches or scrapes. If successful, you'll see processed content like markdown or summaries.

4. Check for Errors: If the tools don't work, review Cursor's console logs (accessible via developer tools) for issues like invalid API keys or network errors. Ensure your Firecrawl API key is active and not expired.

Note: This setup runs the MCP server locally via npx on demand. For advanced users, you can explore the Cursor MCP Directory for one-click installations if available.

## Install in Claude Code

Claude Code is an AI-powered coding environment from Anthropic that supports MCP (Model Context Protocol) servers, allowing integration with tools like Firecrawl for web search and scraping directly within your coding sessions.

### Prerequisites
- Claude Code installed and set up on your system (download from the official Anthropic website or via their CLI tools if applicable).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Terminal or command prompt access, as the installation involves running CLI commands.

### Step-by-Step Installation
1. Open your terminal or command prompt.

2. Run the following command to add the Firecrawl MCP server to Claude Code:
   ```
   claude mcp add firecrawl -e FIRECRAWL_API_KEY=your-api-key -- npx -y firecrawl-mcp
   ```
   Replace `your-api-key` with your actual Firecrawl API key. This command configures the MCP server, sets the environment variable for authentication, and integrates it with Claude Code using npx to handle the package execution without a global install.

3. If prompted, follow any additional on-screen instructions from the Claude CLI to complete the setup.

### Verification Steps
1. Launch Claude Code and open a new session or project.

2. Test the integration with sample queries to ensure Firecrawl's tools are working:
   - Search the web: Enter `Search for the latest Next.js 15 features` in Claude Code's prompt interface.
   - Scrape a page: Enter `Scrape firecrawl.dev and tell me what it does`.
   - Get documentation: Enter `Find and scrape the Stripe API docs for payment intents`.

   Claude Code should automatically invoke the Firecrawl MCP server to perform the search or scrape, returning results like summaries, markdown content, or extracted data.

3. Check for errors: If the tools fail to activate, review the console or logs in Claude Code for issues such as invalid API keys or network problems. Ensure your Firecrawl API key is valid and has sufficient credits.

Note: This setup enables seamless web scraping and search within Claude Code, enhancing your AI-assisted coding workflows. For advanced configurations, refer to the official Firecrawl documentation or Claude's MCP guides.

## Install in Windsurf

Windsurf is an AI-powered code editor developed by Codeium, featuring Cascade as its AI assistant. It supports MCP (Model Context Protocol) integration, enabling tools like Firecrawl for web search and scraping to enhance coding workflows.

### Prerequisites
- Windsurf installed on your system (download from https://windsurf.com/editor if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Windsurf's configuration files (typically located in ~/.codeium/windsurf/).

### Step-by-Step Installation
1. Obtain your Firecrawl API key by signing up at https://firecrawl.dev/app and copying it from the dashboard.

2. Locate or create the configuration file: Navigate to your Windsurf configuration directory (usually `~/.codeium/windsurf/`) and open or create `model_config.json`.

3. Add the Firecrawl MCP configuration: Paste the following JSON into the file (or merge it if the file already exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "YOUR_API_KEY"
         }
       }
     }
   }
   ```

   Replace `YOUR_API_KEY` with your actual Firecrawl API key.

4. Save the file and restart Windsurf to apply the changes.

### Verification Steps
1. Restart Windsurf: Close and reopen the application.

2. Open Cascade (Windsurf's AI assistant): Use the appropriate shortcut or toolbar icon (e.g., click the Cascade icon) to start a session.

3. Test with sample queries to verify Firecrawl integration:
   - Search Example: `Search for the latest Tailwind CSS features`
   - Scrape Example: `Scrape firecrawl.dev and explain what it does`
   - Get Docs Example: `Find and scrape the Supabase authentication documentation`

   Windsurf should invoke the Firecrawl MCP server automatically, returning results such as search summaries or scraped content in markdown format.

4. Check for errors: If the tools do not activate, inspect Windsurf's logs or console for issues like invalid API keys or configuration errors. Ensure the API key is valid and Windsurf has access to run npx commands.

Note: This local setup uses npx to dynamically install and run the Firecrawl MCP server on demand. For alternative installations, such as using a hosted MCP or custom configurations, refer to Windsurf's MCP documentation or the Firecrawl repo.

## Install in VS Code

Visual Studio Code (VS Code) is a popular code editor that supports the Model Context Protocol (MCP) through extensions like Continue.dev or Cline. This enables integration with Firecrawl MCP for web scraping, searching, and data extraction tools to enhance AI-assisted coding workflows.

### Prerequisites
- VS Code installed on your system (download from https://code.visualstudio.com if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- An MCP-compatible extension installed in VS Code, such as Continue.dev (from the VS Code Marketplace) or Cline.
- Terminal access for troubleshooting, if necessary.

### Step-by-Step Installation
1. Open VS Code User Settings (JSON): Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), type "Preferences: Open User Settings (JSON)", and select it to open the `settings.json` file.

2. Add the Firecrawl MCP Configuration: Insert the following JSON block into the file (merge with existing content if needed):

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
           "args": [
             "-y",
             "firecrawl-mcp"
           ],
           "env": {
             "FIRECRAWL_API_KEY": "${input:apiKey}"
           }
         }
       }
     }
   }
   ```

   This setup prompts for your Firecrawl API key securely when the server is invoked, rather than hardcoding it.

3. Optional: For workspace-specific setup, create a `.vscode/mcp.json` file in your project root with the same structure (without the top-level "mcp" key if not required by your extension).

4. Handle Potential JSON Validation Issues: If you encounter schema validation errors, disable JSON validation in VS Code settings temporarily to allow the configuration to load.

5. Alternatively, if using the Cline extension: Open Cline in VS Code, go to the MCP Server Marketplace, search for "Firecrawl", and install it. Enter your API key when prompted.

### Verification Steps
1. Save the settings and restart VS Code (or reload the window via `Ctrl+R` or `Cmd+R` on macOS).

2. Open your MCP-compatible extension (e.g., Continue or Cline) and start a new AI session or chat.

3. When invoking Firecrawl tools for the first time, enter your API key in the prompt that appears.

4. Test with sample queries to verify integration:
   - Search Example: `Search the web for VS Code extension best practices`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize the features`
   - Crawl Example: `Crawl the documentation section of firecrawl.dev`

   The extension should activate the Firecrawl MCP server, process the request, and return results like markdown content or data extracts.

5. Check for errors: If tools fail, review the extension's console or VS Code's output logs for issues like invalid keys or server startup problems. Ensure your API key is valid.

Note: This configuration runs the MCP server locally on demand via npx. For advanced setups or troubleshooting, refer to the Firecrawl documentation or your extension's MCP guides.

## Install in Cline

Cline is a VS Code extension that provides an AI-powered coding assistant with support for the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search capabilities directly within Cline for enhanced development capabilities.

### Prerequisites
- Visual Studio Code (VS Code) version 1.60 or higher installed.
- Node.js version 14.x or higher (check with `node --version` in your terminal).
- The Cline extension installed from the VS Code Extensions Marketplace (search for "Cline" and install the latest version).
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Stable internet connection for installation and API access.
- Optional: Python 3.10 or higher and UV package manager if using other MCP servers, but not required for Firecrawl.

### Step-by-Step Installation
1. Open VS Code and ensure the Cline extension is active. If not installed, go to the Extensions view (Ctrl+Shift+X or Cmd+Shift+X on macOS), search for "Cline", and install it.

2. Access the MCP Marketplace in Cline: Click the “Extensions” button (square icon) in Cline’s top toolbar or navigate via the Cline interface (e.g., open the terminal or chat and ask Cline to "open MCP Marketplace").

3. Search and Install Firecrawl: In the MCP Marketplace, browse categories (e.g., Search or Web Interaction) or search directly for "Firecrawl MCP" or "firecrawl-mcp-server". Click on the server to view details, then click the "Install" button.

4. Configure the API Key: During or after installation, Cline will prompt you for the Firecrawl API key. Enter it securely as guided. Alternatively, manually edit the MCP configuration JSON (accessible via "Configure MCP Servers" in Cline or at `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` on macOS). Add or update the following block:

   ```json
   {
     "mcpServers": {
       "github.com/mendableai/firecrawl-mcp-server": {
         "command": "cmd",
         "args": [
           "/c",
           "set FIRECRAWL_API_KEY=your_api_key_here && npx -y firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         },
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   Replace `your_api_key_here` with your actual Firecrawl API key. Save the file and refresh the MCP servers in Cline.

5. Verify Configuration: In Cline's MCP settings UI, check for a green dot next to the Firecrawl server indicating it's active and configured correctly.

### Verification Steps
1. Restart VS Code or reload the Cline extension to apply changes.

2. Open a Cline session: Use the chat interface or terminal in VS Code to interact with Cline.

3. Test with sample queries to confirm Firecrawl integration:
   - Search Example: `Search the web for recent updates on React 19`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize its features`
   - Crawl Example: `Crawl the blog section of firecrawl.dev and extract article titles`

   Cline should automatically use the Firecrawl MCP tools, returning results like markdown content, summaries, or extracted data.

4. Check for Errors: If tools fail, review Cline's output logs or the MCP server status for issues like invalid API keys. A green dot in the settings confirms readiness; if red, recheck the configuration.

Note: Firecrawl MCP is typically listed under web interaction categories in the marketplace. For advanced rules, define triggers in a `.clinerules` file to activate it contextually. Refer to Cline docs for troubleshooting or custom setups.

## Install in Zed

Zed is a high-performance, collaborative code editor that supports extensions for integrating Model Context Protocol (MCP) servers. The Firecrawl MCP Server extension enables web scraping, crawling, and search tools to enhance AI-assisted coding in Zed.

### Prerequisites
- Zed editor installed on your system (download from https://zed.dev if needed).
- Node.js (version 16 or higher) and npm installed, as the extension may use npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Zed's Command Palette and settings.

### Step-by-Step Installation
1. Open the Command Palette in Zed: Press `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux, then search for "zed: extensions" and select it to open the extensions page.

2. Search and Install the Extension: In the extensions page, search for "Firecrawl MCP Server". Click on it to view details, then click "Install" to add the extension to Zed.

3. Open Zed's Settings: Use the Command Palette again, search for "zed: open settings", and select it to open the `settings.json` file.

4. Configure the API Key: Add the following configuration to the `settings.json` file under the appropriate section (e.g., merge into "context_servers" or "mcpServers" if it exists):

   ```json
   {
     "context_servers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file.

5. Enable the Extension: If required, ensure the extension is enabled in the extensions page (look for an "Installed" filter and toggle if necessary).

### Verification Steps
1. Restart Zed: Close and reopen the application to apply the changes.

2. Check Tool Status: In Zed's assistant settings or extensions page, look for the Firecrawl tool status. A green dot indicates it's active; if red, verify the API key and configuration.

3. Test with Sample Queries: Open Zed's AI assistant or chat interface and enter queries that use Firecrawl tools:
   - Search Example: `Search for Zed editor extensions best practices`
   - Scrape Example: `Scrape https://firecrawl.dev and describe its capabilities`
   - Crawl Example: `Crawl the docs on zed.dev and summarize MCP integration`

   Zed should invoke the Firecrawl MCP server and return processed results like markdown or data extracts.

4. Check for Errors: If tools fail, review Zed's console logs (accessible via developer tools) for issues like invalid API keys or server errors. Ensure the API key is valid and not rate-limited.

Note: This setup integrates Firecrawl via the official extension for seamless MCP support. For advanced configurations or troubleshooting, refer to Zed's documentation or the Firecrawl repo.

## Install in Augment Code

Augment Code is an AI-enhanced code editor that supports the Model Context Protocol (MCP) for integrating external tools like Firecrawl, enabling web scraping, crawling, and search functionalities to improve coding productivity.

### Prerequisites
- Augment Code installed on your system (download from https://www.augmentcode.com if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Augment Code's Settings Panel.

### Step-by-Step Installation
1. Open the Augment Settings Panel: Click the gear icon in the Augment panel (usually located in the sidebar or bottom toolbar) to access the settings.

2. Navigate to the MCP Section: In the settings panel, find the "MCP Servers" or "Model Context Protocol" section. This area allows you to manage and add new MCP integrations.

3. Import or Add JSON Configuration: Click on "Import JSON" or "Add New MCP Server" and paste the following JSON configuration:

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. If the interface supports direct editing, merge this into the existing MCP configuration.

4. Save the Changes: Confirm and save the configuration. Augment Code may prompt for validation or additional details.

### Verification Steps
1. Restart Augment Code: Close and reopen the application to ensure the changes take effect.

2. Open the AI Assistant Interface: Access Augment's chat or assistant panel (e.g., via a shortcut like Cmd+J on macOS).

3. Test with Sample Queries: Enter queries that leverage Firecrawl tools to verify the integration:
   - Search Example: `Search for Augment Code MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and list key features`
   - Crawl Example: `Crawl the Augment docs and summarize MCP setup`

   The assistant should invoke the Firecrawl MCP server and provide results such as scraped content or search summaries.

4. Check for Errors: If the tools do not work, review Augment's logs or MCP status in the settings panel for issues like invalid API keys or configuration errors. Ensure the API key is active.

Note: This setup runs the MCP server locally via npx. For remote or advanced configurations, refer to Augment Code's official MCP documentation or community guides for any updates.

## Install in Roo Code

Roo Code is an AI-powered VS Code extension that enhances coding workflows with support for the Model Context Protocol (MCP). Integrating Firecrawl MCP allows for web scraping, crawling, and search tools directly within Roo Code's chat and assistant features.

### Prerequisites
- Visual Studio Code (VS Code) installed with the Roo Code extension from the VS Code Marketplace (search for "Roo Code" and install).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Roo Code's pane and MCP settings within VS Code.

### Step-by-Step Installation
1. Open the Roo Code pane in VS Code: If not already visible, open it via the sidebar or by searching "Roo Code: Open Pane" in the Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS).

2. Access MCP Settings: In the Roo Code pane, click the MCP settings icon in the top navigation to open the MCP configuration view.

3. Edit the Configuration File: Scroll to the bottom and click "Edit Global MCP" to open `mcp_settings.json` (for all workspaces) or "Edit Project MCP" to create/open `.roo/mcp.json` in your project root (for workspace-specific setup).

4. Add the Firecrawl MCP Configuration: Paste the following JSON into the file under the `mcpServers` object (merge if it already exists). For macOS/Linux:

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         },
         "disabled": false
       }
     }
   }
   ```

   For Windows, use:

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "cmd",
         "args": [
           "/c",
           "npx",
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         },
         "disabled": false
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file.

5. Enable MCP if Needed: In the MCP settings view, toggle "Enable MCP Servers" to ON if it's disabled.

### Verification Steps
1. Reload VS Code or the Roo Code extension to apply changes (use Command Palette: "Developer: Reload Window").

2. Check the MCP Server List: In the Roo Code pane's MCP settings, verify that "firecrawl" appears in the list with an enabled toggle and no errors.

3. Test with Sample Queries: Open the Roo Code chat and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Roo Code MCP updates`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize its tools`
   - Crawl Example: `Crawl the Roo Code docs and extract MCP setup steps`

   Roo Code should invoke the Firecrawl MCP server, process the request, and return results like markdown content or summaries.

4. Check for Errors: If the server fails, use the restart icon in the MCP list or check VS Code's output logs (Output > Roo Code) for issues like invalid API keys. Ensure the API key is valid and Node.js is accessible.

Note: This local STDIO setup runs the server on demand. For remote options or custom tools, refer to Roo Code's MCP documentation or community resources.

## Install in Gemini CLI

Gemini CLI is a command-line interface for Google's Gemini AI, supporting Model Context Protocol (MCP) servers to integrate tools like Firecrawl for web scraping, crawling, and search capabilities, enhancing AI-driven interactions and workflows.

### Prerequisites
- Gemini CLI installed and authenticated following official instructions (e.g., via npm or download).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to a terminal or command prompt for running CLI commands.

### Step-by-Step Installation
1. Open your terminal or command prompt.

2. Use the Gemini CLI command to add the Firecrawl MCP server:
   ```
   gemini mcp add firecrawl npx -y firecrawl-mcp -e FIRECRAWL_API_KEY=your_api_key_here
   ```
   Replace `your_api_key_here` with your actual Firecrawl API key. This command adds the server using stdio transport, sets the environment variable for authentication, and configures it to run via npx without a global install.

3. Alternatively, manually edit the settings.json file: Locate or create `~/.gemini/settings.json` (user-wide) or `.gemini/settings.json` in your project root (project-specific). Add the following JSON block:
   ```
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```
   Replace `your_api_key_here` with your actual Firecrawl API key. Save the file.

4. If prompted during the process, follow any additional instructions for configuration or authentication.

### Verification Steps
1. Run the following command to list configured MCP servers and check status:
   ```
   gemini mcp list
   ```
   Look for "firecrawl" in the list with a "CONNECTED" status. If disconnected, check logs with `gemini --debug` or verify the API key.

2. Use the `/mcp` command in a Gemini CLI session to view server details, available tools (e.g., firecrawl_scrape, firecrawl_search), and discovery state.

3. Test with sample queries in the Gemini CLI chat interface:
   - Search Example: `Search for Gemini CLI updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the docs section of firecrawl.dev`

   The CLI should invoke the Firecrawl MCP server automatically, returning results like markdown content, summaries, or extracted data.

4. Check for errors: If tools fail, review Gemini CLI logs for issues such as invalid API keys or connection problems. Ensure the API key is valid and has sufficient credits.

Note: This setup uses a local stdio MCP server launched on demand. For remote HTTP or SSE configurations, adapt using `gemini mcp add --transport http` with the hosted Firecrawl endpoint (e.g., https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp). Refer to Gemini CLI documentation for advanced options like tool filtering or trust settings.

## Install in Claude Desktop

Claude Desktop is the desktop application for Anthropic's Claude AI, providing an offline-capable interface with support for Model Context Protocol (MCP) integrations. Adding Firecrawl MCP enables web scraping, crawling, and search tools to extend Claude's capabilities for research and data extraction tasks.

### Prerequisites
- Claude Desktop app installed on your system (download from the official Anthropic website or app store if available).
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to the Claude Desktop configuration directory (typically `~/.claude/` on macOS/Linux or `%APPDATA%\Claude` on Windows).
- Internet connection for initial setup and API calls (Claude Desktop may support offline modes, but MCP tools require online access).

### Step-by-Step Installation
1. Obtain your Firecrawl API key by signing up at https://firecrawl.dev/app and copying it from the dashboard.

2. Locate or create the configuration file: Navigate to the Claude Desktop config directory (e.g., `~/.claude/claude_desktop_config.json` on macOS/Linux). If the file doesn't exist, create it as a new JSON file.

3. Add the Firecrawl MCP configuration: Paste the following JSON into the file (or merge it if the file already has content):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "url": "https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_API_KEY"
         }
       }
     }
   }
   ```

   Replace both instances of `YOUR_API_KEY` with your actual Firecrawl API key. This setup uses Firecrawl's remote hosted MCP endpoint for easier integration without local server management.

4. Save the file and ensure the JSON is valid (no trailing commas or syntax errors).

### Verification Steps
1. Restart Claude Desktop: Close and reopen the application to load the new configuration.

2. Check MCP Integration: In Claude Desktop's settings or extensions menu (if available), look for MCP servers. Verify that "firecrawl" is listed and shows as connected or enabled.

3. Test with sample queries in a new Claude session:
   - Search Example: `Search the web for Claude Desktop MCP features`
   - Scrape Example: `Scrape https://firecrawl.dev and explain its purpose`
   - Crawl Example: `Crawl the Anthropic docs and summarize MCP support`

   Claude should automatically use the Firecrawl MCP tools, returning results such as summaries, markdown content, or extracted data from the web.

4. Check for Errors: If tools fail, review Claude Desktop's logs (accessible via the help menu or console) for issues like invalid API keys or connection errors. Ensure your Firecrawl API key is active and the hosted URL is reachable.

Note: This remote setup avoids local dependencies like Node.js, making it suitable for desktop environments. For local alternatives or advanced configurations, refer to Anthropic's MCP documentation or the Firecrawl repo for stdio-based options.

## Install in Opencode

Opencode is an AI-assisted code editor that supports the Model Context Protocol (MCP) for integrating external tools like Firecrawl, enabling web scraping, crawling, and search functionalities to enhance development and research workflows.

### Prerequisites
- Opencode installed on your system (download from https://opencode.ai if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Opencode's configuration file or MCP management interface.

### Step-by-Step Installation
1. Open your Opencode config file: Locate or create the configuration file, typically at `~/.opencode/settings.json` or accessible via the settings menu in Opencode.

2. Under the "mcp" section, add a unique name for the Firecrawl server and paste the following JSON configuration (merge if the section already exists):

   ```json
   {
     "mcp": {
       "servers": {
         "firecrawl": {
           "command": "npx",
           "args": ["-y", "firecrawl-mcp"],
           "env": {
             "FIRECRAWL_API_KEY": "your_api_key_here"
           }
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key.

3. Save the file. Opencode supports both local (stdio) and remote MCP servers; this setup uses a local configuration.

### Verification Steps
1. Restart Opencode: Close and reopen the application to apply the changes.

2. Check the MCP servers list: In Opencode's settings or MCP management interface, verify that "firecrawl" appears and is enabled.

3. Test with sample queries in Opencode's AI prompt or chat interface:
   - Search Example: `Search for Opencode MCP integration tips`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize the MCP server`
   - Crawl Example: `Crawl the Opencode docs and extract MCP setup details`

   Opencode should invoke the Firecrawl MCP server and return results like markdown content or data extracts.

4. Check for Errors: If the tools fail, review Opencode's logs or console for issues such as invalid API keys or configuration errors. Ensure the API key is valid.

Note: Opencode allows referencing the MCP server by name in prompts for targeted use. For remote setups or advanced options, refer to the Opencode MCP documentation.

## Install in OpenAI Codex

OpenAI Codex is an AI-powered coding assistant from OpenAI that supports the Model Context Protocol (MCP) for integrating tools like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance code generation and research tasks within Codex.

### Prerequisites
- OpenAI Codex CLI installed (run `npm install -g @openai/codex` if not already installed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Terminal or command prompt access for running CLI commands.

### Step-by-Step Installation
1. Open your terminal or command prompt.

2. Use the Codex CLI to add the Firecrawl MCP server:
   ```
   codex mcp add firecrawl --command "npx -y firecrawl-mcp" --env FIRECRAWL_API_KEY=your_api_key_here
   ```
   Replace `your_api_key_here` with your actual Firecrawl API key. This command configures the MCP server to run locally via npx and sets the environment variable for authentication.

3. Alternatively, modify the config file directly: Locate the Codex configuration file (e.g., `~/.codex/config.toml` or as specified in Codex docs) and add the equivalent configuration manually if the CLI command encounters issues.

### Verification Steps
1. Run the following command to list configured MCP servers:
   ```
   codex mcp list
   ```
   Verify that "firecrawl" appears in the list and is enabled.

2. Start a Codex session and test with sample queries:
   - Search Example: `Search for OpenAI Codex MCP examples`
   - Scrape Example: `Scrape https://firecrawl.dev and describe the API`
   - Crawl Example: `Crawl the OpenAI docs and summarize Codex features`

   Codex should invoke the Firecrawl MCP server and return processed results like summaries or extracted data.

3. Check for errors: If the tools fail, review Codex logs or run with debug mode (e.g., `codex --debug`) for issues like invalid API keys or configuration problems. Ensure the API key is valid.

Note: This setup integrates Firecrawl as a local MCP server. For remote configurations or advanced options, refer to OpenAI's Codex MCP documentation.

## Install in JetBrains AI Assistant

JetBrains AI Assistant is an AI-powered feature integrated into JetBrains IDEs (such as IntelliJ IDEA, PyCharm, and others) that supports the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search tools to enhance code completion, chat interactions, and development workflows within the IDE.

### Prerequisites
- A JetBrains IDE (e.g., IntelliJ IDEA Ultimate, PyCharm Professional) with the AI Assistant plugin enabled (version supporting MCP, typically 2024.3 or later).
- Node.js (version 16 or higher) and npm installed for local setups using npx.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Optional: The "MCP Servers for AI Assistants" plugin installed from the JetBrains Marketplace for easier browsing and installation from a registry (search for "MCP Servers for AI Assistants" in Plugins settings).
- Access to the IDE's Settings menu.

### Step-by-Step Installation
1. Open the IDE and navigate to MCP settings: Go to **Settings** (or **Preferences** on macOS) > **Tools** > **AI Assistant** > **Model Context Protocol (MCP)**.

2. Add a new MCP server: On the MCP settings page, click **Add** to open the New MCP Server dialog.

3. Choose the transport and configuration:
   - For a **local setup** (recommended for custom control, using STDIO transport):
     - Select **STDIO** as the transport.
     - Enter a name like "firecrawl".
     - Provide the following JSON configuration (adjust paths if needed):
       ```json
       {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
       ```
       Replace `"your_api_key_here"` with your actual Firecrawl API key.
     - Specify a working directory if the command requires it (e.g., your project root).
   - For a **remote hosted setup** (easier, no local dependencies, using Streamable HTTP transport):
     - Select **Streamable HTTP** as the transport.
     - Provide the following JSON configuration:
       ```json
       {
         "url": "https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_API_KEY"
         }
       }
       ```
       Replace both instances of `YOUR_API_KEY` with your actual Firecrawl API key.

4. Save and apply: Click **OK** to add the server, then **Apply**. The IDE will attempt to start or connect to the server.

5. Alternative using the MCP Servers plugin (if installed):
   - Open the **MCP Servers** tool window (via View > Tool Windows > MCP Servers).
   - Search for "Firecrawl" in the registry (if available) or click **+** to add a custom server.
   - Follow the plugin's prompts to install and configure, entering your API key in the environment variables or headers section.
   - Save and restart the server if prompted.

### Verification Steps
1. Check server status: In the MCP settings page, look for the "firecrawl" server in the list. A green indicator in the **Status** column means it's connected and active. If red or disconnected, click **Reconnect** or check logs.

2. Review available tools: Click the status icon next to the server to list its tools (e.g., firecrawl_scrape, firecrawl_search, firecrawl_crawl). Ensure they match Firecrawl's capabilities.

3. Test in the AI Assistant chat: Open the AI Assistant panel (via Tools > AI Assistant or sidebar icon) and enter sample queries:
   - Search Example: `Search for JetBrains AI Assistant updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize MCP integration`
   - Crawl Example: `Crawl the JetBrains MCP docs and extract setup steps`
   
   The assistant should invoke the Firecrawl tools automatically, returning results like summaries or markdown content.

4. View logs for errors: If issues occur, go to **Help** > **Show Log in Explorer/Finder** and check the `mcp` folder for server-specific logs. Verify the API key and connection.

Note: Local setups launch the server as a subprocess on demand. For troubleshooting or if Firecrawl isn't in the plugin registry, refer to JetBrains MCP documentation or Firecrawl's repo for updates. Ensure your IDE has internet access for remote setups or API calls.

## Install in Kiro

Kiro is an agentic AI development IDE that supports the Model Context Protocol (MCP) natively, allowing integration with tools like Firecrawl for web scraping, crawling, and search to extend its capabilities from prototype to production workflows.

### Prerequisites
- Kiro IDE installed on your system (download from https://kiro.dev if needed).
- Node.js (version 16 or higher) and npm installed for local setups using npx.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Kiro's "ghost" tab for MCP management.

### Step-by-Step Installation
1. Open Kiro and access the "ghost" tab: Launch Kiro and click on the "ghost" icon or tab in the interface to open the advanced features panel.

2. Navigate to MCP Servers: In the "ghost" tab, scroll or search for "MCP Servers" in the list of options and click on it to view current servers.

3. Add a new MCP server: Click the "+" button to add a new server. This opens a configuration dialog or editor.

4. Configure Firecrawl:
   - For a **local setup** (using STDIO transport):
     - Enter a name like "firecrawl".
     - Provide the following JSON configuration:
       ```json
       {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
       ```
       Replace `"your_api_key_here"` with your actual Firecrawl API key.
   - For a **remote setup** (using hosted endpoint, no local dependencies):
     - Select remote or HTTP transport if available.
     - Provide the following JSON configuration:
       ```json
       {
         "url": "https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_API_KEY"
         }
       }
       ```
       Replace both instances of `YOUR_API_KEY` with your actual Firecrawl API key.

5. Save and apply: Confirm the configuration, save it, and restart Kiro if prompted to activate the new server.

### Verification Steps
1. Restart Kiro: Close and reopen the IDE to ensure the MCP server is loaded.

2. Check MCP status: Return to the "ghost" tab > MCP Servers and verify that "firecrawl" is listed with a connected or active status (e.g., green indicator).

3. Test with sample queries in Kiro's AI chat or assistant interface:
   - Search Example: `Search for Kiro MCP tutorials`
   - Scrape Example: `Scrape https://firecrawl.dev and list features`
   - Crawl Example: `Crawl the Kiro docs and summarize MCP section`

   Kiro should invoke the Firecrawl MCP server and return results like summaries or extracted data.

4. Check for Errors: If the server fails to connect, review Kiro's logs (accessible via the help menu or console) for issues like invalid API keys or configuration errors. Ensure the API key is valid and Node.js is accessible for local setups.

Note: Kiro supports both local and remote MCP configurations, making it flexible for connecting to APIs and data sources. For advanced troubleshooting or spec-driven development with MCP, refer to Kiro's official documentation or tutorials.

## Install in Trae

Trae is an AI-powered IDE that supports the Model Context Protocol (MCP) for integrating external tools like Firecrawl, enabling web scraping, crawling, and search functionalities to enhance agentic development workflows from prototype to production.

### Prerequisites
- Trae AI IDE installed on your system (download from https://trae.ai or follow official installation guides).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Trae's settings or configuration interface for MCP management.

### Step-by-Step Installation
1. Open Trae Settings: Launch Trae and navigate to the Settings panel (typically via a gear icon or menu option like File > Settings).

2. Access MCP Configuration: In the settings, find the "MCP Servers" or "Model Context Protocol" section. This may be under "AI Integrations" or "Extensions."

3. Add or Edit the Configuration: Click "Add New MCP Server" or edit the existing MCP config file (e.g., via a JSON editor in Trae or at `~/.trae/settings.json`). Paste the following JSON block into the `mcpServers` object (merge if it exists):

   ```json
   {
     "mcpServers": {
       "Firecrawl": {
         "command": "npx",
         "args": ["-y", "firecrawl-mcp"],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key.

4. Save and Apply Changes: Save the configuration and restart Trae if prompted to load the new MCP server.

### Verification Steps
1. Restart Trae: Close and reopen the IDE to ensure the changes take effect.

2. Check MCP Status: In the MCP settings section, verify that "Firecrawl" is listed and shows as active or connected (e.g., with a green status indicator).

3. Test with Sample Queries: Open Trae's AI chat or agent interface and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Trae AI IDE updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Trae docs and extract MCP integration steps`

   Trae should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Trae's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For cloud-based or remote configurations, refer to Firecrawl's hosted options or Trae's documentation for advanced MCP integrations.

## Using Bun or Deno

Firecrawl MCP server can be run using alternative JavaScript runtimes like Bun or Deno, which offer compatibility with Node.js projects while providing performance benefits or different module handling. The server is primarily built for Node.js but can be adapted for these runtimes with minimal adjustments, as they support TypeScript/JavaScript execution.

### Prerequisites
- Git installed to clone the repository.
- Bun installed (download from https://bun.sh and follow setup instructions).
- Or Deno installed (download from https://deno.com and follow setup instructions).
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Familiarity with terminal commands, as the setup involves cloning and running scripts.
- Note: Bun is more directly compatible with Node.js dependencies (via `bun install`), while Deno may require adjustments for Node module compatibility (e.g., using `--compat` flag or import maps if issues arise).

### Step-by-Step Installation
1. Clone the Firecrawl MCP server repository:
   ```
   git clone https://github.com/mendableai/firecrawl-mcp-server
   ```
   This downloads the source code to your local machine.

2. Navigate to the repository directory:
   ```
   cd firecrawl-mcp-server
   ```

3. **For Bun:**
   - Install dependencies (Bun handles `package.json` and installs faster than npm):
     ```
     bun install
     ```
   - Run the server with your Firecrawl API key (assuming the `package.json` has a "start" script like "node index.js"; Bun will execute it compatibly):
     ```
     FIRECRAWL_API_KEY=your_api_key_here bun run start
     ```
     Replace `your_api_key_here` with your actual Firecrawl API key. For streamable HTTP mode, add `HTTP_STREAMABLE_SERVER=true` to the environment variables.
     - If no "start" script exists, directly run the entry file (e.g., `bun index.js` or `bun src/index.ts` based on the repo structure).

4. **For Deno:**
   - Deno doesn't require installing dependencies via a package manager (it fetches them on-the-fly), but ensure compatibility with Node modules by using the `--node-modules-dir` flag if needed.
   - Run the server with necessary allowances (for network, environment, etc.):
     ```
     FIRECRAWL_API_KEY=your_api_key_here deno run --allow-net --allow-env --allow-read --node-modules-dir index.js
     ```
     Replace `your_api_key_here` with your actual Firecrawl API key. Adjust the entry file (e.g., `index.js` or `src/index.ts`) based on the repo. For streamable mode, add `HTTP_STREAMABLE_SERVER=true`.
     - If compatibility issues occur (e.g., with Node-specific APIs), use Deno's Node compatibility mode: `--compat`.
     - Note: Deno may require an import map for certain dependencies; create an `import_map.json` if errors arise (refer to Deno docs for setup).

### Verification Steps
1. Start the server using the commands above and check the terminal output for confirmation (e.g., "Server running on http://localhost:3000").

2. Test the MCP endpoint: Use a tool like curl to verify the server is responding:
   ```
   curl http://localhost:3000/v2/mcp
   ```
   It should return a JSON response describing available tools (e.g., scrape, search, crawl). If in streamable mode, test with appropriate HTTP requests.

3. Integrate with an MCP client: Configure a client like Cursor or Claude Code to point to your local server (e.g., via MCP config with `"command": "bun run start"` or similar for Bun/Deno). Run a sample query:
   - Search Example: `Search for Firecrawl updates`
   - Scrape Example: `Scrape https://firecrawl.dev`

   The client should invoke the tools and return results.

4. Check for errors: Monitor terminal logs for issues like missing dependencies or invalid API keys. If the server fails to start, verify your API key and runtime versions. For Bun/Deno-specific errors, consult their documentation for Node compatibility fixes.

Note: While the Firecrawl MCP server is Node.js-based, Bun offers drop-in replacement with performance gains, and Deno provides secure execution with allowances. If full compatibility isn't achieved, fall back to Node.js or contribute adjustments to the repo. For production, consider Docker for consistency across runtimes.

## Using Docker

Docker provides a containerized environment for running the Firecrawl MCP server, ensuring consistency across different systems and simplifying deployment. This method is ideal for self-hosting the server without installing Node.js or dependencies directly on your machine.

### Prerequisites
- Docker installed on your system (download Docker Desktop from https://www.docker.com/products/docker-desktop if needed).
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Basic familiarity with terminal commands for running Docker.
- Optional: Docker Compose if you prefer managing services via a YAML file, though not required for basic setup.

### Step-by-Step Installation
1. Pull the Docker image from Docker Hub:
   ```
   docker pull mcp/firecrawl
   ```
   This downloads the official Firecrawl MCP server image.

2. Run the container:
   ```
   docker run -d -p 3000:3000 --env FIRECRAWL_API_KEY=your_api_key_here mcp/firecrawl
   ```
   - Replace `your_api_key_here` with your actual Firecrawl API key.
   - The `-d` flag runs the container in detached mode (background).
   - The `-p 3000:3000` maps the container's port 3000 to your host's port 3000.
   - Optional: For streamable HTTP mode, add `--env HTTP_STREAMABLE_SERVER=true`.
   - Additional environment variables can be set if needed, such as `--env FIRECRAWL_API_URL=https://api.firecrawl.dev/v1` or retry settings (e.g., `--env FIRECRAWL_RETRY_MAX_ATTEMPTS=5`).

3. If using Docker Compose (for easier management), create a `docker-compose.yml` file with the following content:
   ```
   version: '3'
   services:
     firecrawl-mcp:
       image: mcp/firecrawl
       ports:
         - "3000:3000"
       environment:
         - FIRECRAWL_API_KEY=your_api_key_here
   ```
   Then run:
   ```
   docker-compose up -d
   ```
   Replace `your_api_key_here` with your API key.

### Verification Steps
1. Check if the container is running:
   ```
   docker ps
   ```
   Look for the `mcp/firecrawl` image in the list.

2. Test the MCP endpoint: Open a browser or use curl to access `http://localhost:3000/v2/mcp`. It should return a JSON response describing available tools (e.g., firecrawl_scrape, firecrawl_search).

3. Integrate with an MCP client: Configure your client (e.g., Cursor or Claude) to use the local Docker server URL (http://localhost:3000/v2/mcp). Test with sample queries:
   - Search Example: `Search for Docker best practices`
   - Scrape Example: `Scrape https://firecrawl.dev`

   The client should connect to the Docker-hosted server and return results.

4. Check logs for errors: Run `docker logs <container_id>` (get ID from `docker ps`) to verify no issues like invalid API keys. Ensure the API key is valid and the container has network access.

Note: This setup runs the MCP server in a container, accessible locally. For production or remote access, consider exposing ports securely or using a reverse proxy. Customize environment variables as needed for retries or credit thresholds. If building from source, use the Dockerfile in the repo.

## Install Using the Desktop Extension

The "Desktop Extension" typically refers to browser-based extensions or desktop app integrations that support the Model Context Protocol (MCP) for AI assistants, allowing Firecrawl to be used for web scraping and search in desktop environments. This can include Chrome/Edge extensions with AI features or direct integrations in desktop clients like Claude Desktop. The setup often uses a remote hosted MCP URL for simplicity, avoiding local server management.

### Prerequisites
- A compatible desktop extension or app, such as a Chrome/Edge AI assistant extension (e.g., ones supporting MCP like Claude-integrated extensions) or Claude Desktop.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Google Chrome or Microsoft Edge browser installed if using browser extensions.
- Access to the extension's settings or configuration panel.
- Note: If the extension is for an IDE like VS Code, refer to the VS Code section; this focuses on browser/desktop app extensions.

### Step-by-Step Installation
1. Install the Compatible Extension: 
   - Open your browser (Chrome/Edge) and go to the Chrome Web Store or Microsoft Edge Add-ons.
   - Search for AI assistant extensions that support MCP (e.g., "Claude AI Extension" or similar MCP-enabled tools). Install the extension from the store.
   - For Claude Desktop-specific extensions, download from official sources if available.

2. Configure the MCP URL in Extension Settings:
   - Open the extension's settings (usually by clicking the extension icon and selecting "Options" or "Settings").
   - Locate the MCP or AI tool configuration section.
   - Add the remote Firecrawl MCP endpoint:
     ```
     URL: https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp
     ```
     Replace `{YOUR_API_KEY}` with your actual Firecrawl API key.
   - If required, add authorization headers:
     ```json
     {
       "headers": {
         "Authorization": "Bearer YOUR_API_KEY"
       }
     }
     ```
     Replace `YOUR_API_KEY` with your actual API key.

3. Save and Reload: Save the changes and reload the extension or browser tab to apply the configuration.

4. For Claude Desktop Integration (if using as a desktop extension):
   - Follow the Claude Desktop section for JSON config in `claude_desktop_config.json`, as it acts like an extension for desktop use.

### Verification Steps
1. Open the Extension Interface: Activate the extension (e.g., via toolbar icon) and check if the MCP server is listed or connected in the settings.

2. Test with Sample Queries: In the extension's chat or prompt interface, enter queries using Firecrawl tools:
   - Search Example: `Search for desktop extension MCP updates`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`

   The extension should invoke the Firecrawl MCP and return results like summaries or markdown content.

3. Check for Errors: Review the extension's console (via browser dev tools) or logs for issues like invalid API keys or connection failures. Ensure the API key is valid and the URL is accessible.

Note: Specific "Desktop Extension" may vary by browser or app; adapt based on your setup (e.g., Chrome for AI assistants). For IDE-specific extensions, see respective sections. This remote setup eliminates local dependencies.

## Install in Windows

Firecrawl MCP server can be installed and run on Windows systems, leveraging Node.js for execution. This setup enables integration with MCP-compatible IDEs and clients on Windows, such as VS Code or Cursor, for web scraping and search tools.

### Prerequisites
- Windows 10 or later (64-bit recommended).
- Node.js (version 16 or higher) and npm installed. Download the LTS version from https://nodejs.org and install it, ensuring "Add to PATH" is selected during setup.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Command Prompt or PowerShell for running commands.
- Optional: An MCP-compatible IDE like VS Code installed for integration testing.

### Step-by-Step Installation
1. Install Node.js: Download and run the installer from https://nodejs.org. Follow the prompts, and verify installation by opening Command Prompt or PowerShell and running `node --version` and `npm --version`.

2. Open Command Prompt or PowerShell: Search for "cmd" or "PowerShell" in the Start menu and launch it.

3. Install Firecrawl MCP globally (optional, for easier access; otherwise, use npx for on-demand runs):
   ```
   npm install -g firecrawl-mcp
   ```

4. Run the MCP server:
   - In Command Prompt:
     ```
     cmd /c "set FIRECRAWL_API_KEY=your_api_key_here && npx -y firecrawl-mcp"
     ```
     Replace `your_api_key_here` with your actual Firecrawl API key.
   - In PowerShell:
     ```
     $env:FIRECRAWL_API_KEY="your_api_key_here"; npx -y firecrawl-mcp
     ```
     Replace `your_api_key_here` with your actual Firecrawl API key.
   - If globally installed:
     ```
     FIRECRAWL_API_KEY=your_api_key_here firecrawl-mcp
     ```
     (Adapt for PowerShell as above.)

   This starts the local MCP server, typically on port 3000.

### Verification Steps
1. After running the command, check the terminal output for confirmation (e.g., "Server running on http://localhost:3000/v2/mcp").

2. Test the endpoint: Open a browser and navigate to http://localhost:3000/v2/mcp, or use curl in Command Prompt/PowerShell:
   ```
   curl http://localhost:3000/v2/mcp
   ```
   It should return a JSON response with available tools (e.g., scrape, search, crawl).

3. Integrate with a Windows-based MCP client (e.g., VS Code with Continue.dev or Cursor): Follow the respective IDE's MCP setup, using the local server command or URL. Test with sample queries:
   - Search Example: `Search for Windows Node.js tips`
   - Scrape Example: `Scrape https://firecrawl.dev`

   The client should invoke the tools and return results.

4. Check for errors: If the server fails to start, review terminal logs for issues like invalid API keys or port conflicts. Ensure Node.js is in your PATH (restart terminal if needed) and the API key is valid.

Note: On Windows, use Command Prompt for `set` or PowerShell for `$env:` to handle environment variables. For IDE integrations, refer to earlier sections like VS Code. If using WSL, treat it as Linux setup.

## Install in Amazon Q Developer CLI

Amazon Q Developer CLI is an AI-powered command-line tool from AWS that supports the Model Context Protocol (MCP), allowing integration with tools like Firecrawl for web scraping, crawling, and search to enhance developer workflows and automate tasks.

### Prerequisites
- Amazon Q Developer CLI installed and authenticated (follow AWS docs to install via npm or AWS CLI, e.g., `npm install -g @aws/q-developer-cli`, and log in with `q login`).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to a terminal or command prompt for running CLI commands and editing files.

### Step-by-Step Installation
1. Locate or create the MCP configuration file: Navigate to `~/.aws/amazonq/` (on Windows: `%USERPROFILE%\.aws\amazonq\`) and create or open `mcp.json` in a text editor.

2. Add the Firecrawl MCP server configuration: Paste the following JSON into the file (merge with existing content if needed):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file and ensure the JSON is valid.

3. (Optional) Set environment variables globally: If needed, export the API key in your shell before starting the CLI:
   ```
   export FIRECRAWL_API_KEY=your_api_key_here
   ```
   (On Windows: `set FIRECRAWL_API_KEY=your_api_key_here`).

4. Restart or start the Amazon Q Developer CLI: Run `q chat` to initiate a session. The CLI will load the MCP servers from the config file.

5. Trust the tools: In the Q CLI chat interface, run `/tools trust` to mark the Firecrawl tools as trusted, enabling automatic use without prompts.

### Verification Steps
1. Check loading status: Upon starting `q chat`, look for messages like "1 of 1 mcp servers initialized" or "✓ firecrawl loaded in Xs". If errors occur, check logs in `$TMPDIR/qlog`.

2. Use the /mcp command: In the chat session, run `/mcp` to view loaded servers and their status. Verify "firecrawl" is listed as connected.

3. Test with sample queries: In the Q CLI chat, enter queries that use Firecrawl tools:
   - Search Example: `Search for AWS Q Developer CLI updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the AWS docs for MCP setup`

   Q should invoke the Firecrawl MCP server and return results like summaries or extracted data.

4. Check for errors: If tools fail, review CLI output or logs for issues like invalid API keys or loading timeouts. Ensure the API key is valid and Node.js is accessible.

Note: This setup uses a local STDIO MCP server launched on demand. For remote configurations or additional servers, extend the `mcp.json` file and restart the CLI. Refer to AWS documentation for advanced options like tool filtering or trust settings.

## Install in Warp

Warp is a modern terminal application that supports the Model Context Protocol (MCP) for integrating external tools like Firecrawl, enabling web scraping, crawling, and search functionalities directly within the terminal environment.

### Prerequisites
- Warp terminal installed on your system (download from https://warp.dev if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Warp's Drive tab for MCP server management.

### Step-by-Step Installation
1. Open Warp and access the Drive tab: Launch Warp and click on the Drive tab in the interface to open the workspace management panel.

2. Navigate to MCP Servers: In the Drive tab, scroll or search for "MCP Servers" in the list of options and click on it to view current servers.

3. Add a new MCP server: Click the "+" button to add a new server. This opens a configuration dialog or editor.

4. Configure Firecrawl:
   - Enter a name like "firecrawl".
   - Provide the following JSON configuration:
     ```json
     {
       "command": "npx",
       "args": [
         "-y",
         "firecrawl-mcp"
       ],
       "env": {
         "FIRECRAWL_API_KEY": "your_api_key_here"
       }
     }
     ```
     Replace `"your_api_key_here"` with your actual Firecrawl API key.

5. Apply changes: Save the configuration and apply the changes to activate the new MCP server.

### Verification Steps
1. Check server status: Return to the MCP Servers section in the Drive tab and verify that "firecrawl" is listed with a connected or active status (e.g., green indicator).

2. Test with sample queries in Warp's terminal or AI interface:
   - Search Example: `Search for Warp terminal features`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize capabilities`
   - Crawl Example: `Crawl the Warp docs and extract MCP setup steps`

   Warp should invoke the Firecrawl MCP server and return results like summaries or extracted data.

3. Check for Errors: If the server fails to connect, review Warp's logs or console output for issues like invalid API keys or configuration errors. Ensure the API key is valid and Node.js is accessible.

Note: This setup runs the MCP server locally via npx on demand. For alternative setups or troubleshooting, refer to Warp's documentation or the Firecrawl repository. The local setup provides flexibility while maintaining security within the terminal environment.

## Install in Copilot Coding Agent

Copilot Coding Agent refers to GitHub Copilot's AI-powered coding assistant, often integrated into environments like VS Code or GitHub Codespaces, with support for the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search tools to enhance code suggestions, chat interactions, and agentic workflows within Copilot.

### Prerequisites
- GitHub Copilot subscription and the Copilot extension installed in a compatible IDE (e.g., VS Code) via the GitHub Copilot extension from the Marketplace.
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Copilot's settings or configuration in your IDE (e.g., VS Code's settings.json).
- Optional: GitHub Copilot Chat or Agents enabled for full MCP utilization.

### Step-by-Step Installation
1. Open your IDE (e.g., VS Code) and ensure GitHub Copilot is active: Sign in to GitHub Copilot via the extension settings if not already configured.

2. Access MCP Configuration: In VS Code, open the User Settings JSON (Ctrl+Shift+P or Cmd+Shift+P on macOS, search for "Preferences: Open User Settings (JSON)"). If using another IDE, locate the Copilot or MCP settings panel.

3. Add the Firecrawl MCP Server: Insert the following JSON block into the settings.json under the "github.copilot" or "mcpServers" section (merge if it exists; Copilot may use a dedicated MCP config via extensions like Continue.dev for advanced support):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file.

4. Enable MCP in Copilot: In the Copilot extension settings, toggle on any MCP or tool integration options if available. Restart the IDE to apply changes.

5. For CLI-based Copilot Agents: If using GitHub Copilot CLI (via `npm install -g @githubnext/github-copilot-cli`), run:

   ```bash
   copilot mcp add firecrawl --npx -y firecrawl-mcp -e FIRECRAWL_API_KEY=your_api_key_here
   ```

   Replace `your_api_key_here` with your API key.

### Verification Steps
1. Restart your IDE: Close and reopen to load the new configuration.

2. Check MCP Status: In Copilot's chat or settings panel, verify that Firecrawl tools are available (e.g., via `/tools` or `mcp list` command in chat).

3. Test with Sample Queries: Open Copilot Chat (e.g., Ctrl+Shift+I in VS Code) and enter queries that leverage Firecrawl:
   - Search Example: `Search for GitHub Copilot MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Copilot docs and extract agent setup steps`

   Copilot should invoke the Firecrawl MCP server and return results like summaries or extracted data.

4. Check for Errors: If tools fail, review Copilot's logs or IDE output for issues like invalid API keys or configuration problems. Ensure the API key is valid and Node.js is accessible.

Note: This setup integrates Firecrawl as a local MCP server within Copilot's ecosystem. For remote configurations or advanced agent workflows, refer to GitHub Copilot's MCP documentation or the Firecrawl repository for hosted endpoints.

## Install in Copilot CLI

Copilot CLI is a command-line interface for GitHub Copilot, an AI-powered coding assistant that supports the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search tools to enhance code generation, debugging, and research tasks directly from the terminal.

### Prerequisites
- Copilot CLI installed (run `npm install -g @githubnext/github-copilot-cli` and authenticate with `github-copilot-cli auth` using your GitHub account with Copilot access).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Terminal or command prompt access for running CLI commands.

### Step-by-Step Installation
1. Open your terminal or command prompt.

2. Use the Copilot CLI to add the Firecrawl MCP server:
   ```bash
   github-copilot-cli mcp add firecrawl --command "npx -y firecrawl-mcp" --env FIRECRAWL_API_KEY=your_api_key_here
   ```
   Replace `your_api_key_here` with your actual Firecrawl API key. This command configures the MCP server to run locally via npx and sets the environment variable for authentication.

3. Alternatively, manually edit the config file: Locate the Copilot CLI configuration (e.g., `~/.copilot/config.json` or as per docs) and add the following JSON block under `mcpServers` (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file.

4. If prompted, follow any additional instructions for authentication or configuration.

### Verification Steps
1. Run the following command to list configured MCP servers:
   ```bash
   github-copilot-cli mcp list
   ```
   Verify that "firecrawl" appears in the list and is enabled/connected.

2. Start a Copilot CLI session (e.g., `github-copilot-cli`) and test with sample queries:
   - Search Example: `Search for Copilot CLI MCP examples`
   - Scrape Example: `Scrape https://firecrawl.dev and describe the API`
   - Crawl Example: `Crawl the GitHub docs and summarize Copilot features`

   Copilot CLI should invoke the Firecrawl MCP server and return processed results like summaries or extracted data.

3. Check for errors: If tools fail, review CLI logs or run with verbose mode (e.g., `--verbose`) for issues like invalid API keys or configuration problems. Ensure the API key is valid.

Note: This setup integrates Firecrawl as a local MCP server for terminal-based workflows. For remote configurations or integration with Copilot in IDEs, refer to related sections like VS Code. Consult GitHub Copilot CLI documentation for advanced MCP options.

## Install in LM Studio

LM Studio is an open-source application for running local large language models (LLMs) on your desktop, with support for the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search tools to enhance model interactions, allowing local LLMs to access real-time web data for more informed responses.

### Prerequisites
- LM Studio installed on your system (download from https://lmstudio.ai if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- A compatible LLM loaded in LM Studio (e.g., models supporting tool calls like Llama or Mistral variants).
- Access to LM Studio's settings or configuration files.

### Step-by-Step Installation
1. Open LM Studio and load a model: Launch the app, search for and download a model that supports tool calling (e.g., via the model hub), then load it into a chat session.

2. Access MCP Configuration: In LM Studio's settings (gear icon or via the menu), navigate to the "Tools" or "MCP Servers" section (may be under "Advanced" or "Extensions" in recent versions).

3. Add the Firecrawl MCP Server: Click "Add MCP Server" or edit the configuration JSON/file (typically at `~/.lmstudio/config.json` or accessible via the UI). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable Tools in Chat: In a new chat session, toggle on "Enable Tools" or select the Firecrawl server from the available MCP options.

5. Restart LM Studio if needed: Close and reopen the app to apply the configuration.

### Verification Steps
1. Check MCP Status: In the chat settings or tools panel, verify that "firecrawl" is listed as active or connected (e.g., with a green status indicator).

2. Test with Sample Queries: Start a chat with your loaded model and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for LM Studio updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the LM Studio docs and extract MCP integration steps`

   The model should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

3. Check for Errors: If tools fail, review LM Studio's console or logs (accessible via the debug menu) for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx, suitable for offline-capable LLMs with online tool access. For remote configurations or troubleshooting model compatibility, refer to LM Studio's documentation or community resources.

## Install in Visual Studio 2022

Visual Studio 2022 is Microsoft's integrated development environment (IDE) for building applications, with support for the Model Context Protocol (MCP) through AI extensions like GitHub Copilot or Visual Studio IntelliCode. Integrating Firecrawl MCP enables web scraping, crawling, and search tools to enhance code generation, debugging, and research workflows within the IDE.

### Prerequisites
- Visual Studio 2022 (version 17.0 or higher) installed, with the AI Toolkit or GitHub Copilot extension enabled (download from the Visual Studio Marketplace or via Extensions > Manage Extensions).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Visual Studio's Tools > Options menu for configuration.
- Optional: .NET workload or AI extensions installed for full MCP support.

### Step-by-Step Installation
1. Open Visual Studio 2022 and navigate to MCP settings: Go to **Tools > Options > AI Toolkit or GitHub Copilot > Model Context Protocol (MCP)** (the exact path may vary based on extensions; if not visible, ensure the AI extension is installed).

2. Add a new MCP server: In the MCP configuration section, click **Add Server** or edit the JSON config file (typically accessible via a button or at `%APPDATA%\Microsoft\VisualStudio\17.0\Extensions\mcp.json`).

3. Configure Firecrawl: Paste the following JSON into the configuration (merge with existing content if needed):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Apply and restart: Click **OK** or **Apply**, then restart Visual Studio 2022 to load the MCP server.

5. Enable in Extensions: If using GitHub Copilot, go to **Extensions > GitHub Copilot** and toggle on MCP integrations if required.

### Verification Steps
1. Restart Visual Studio 2022: Close and reopen the IDE to ensure the configuration is applied.

2. Check MCP Status: In the AI Toolkit or Copilot panel, verify that "firecrawl" is listed as active (e.g., via a status indicator or tools list).

3. Test with Sample Queries: Open the Copilot Chat or AI assistant panel (e.g., via View > GitHub Copilot Chat) and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Visual Studio 2022 MCP updates`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Microsoft docs and extract MCP setup steps`

   The assistant should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Visual Studio's Output window (View > Output, select AI Toolkit or Extensions) for issues like invalid API keys or server errors. Ensure the API key is valid and Node.js is accessible.

Note: This local setup runs the MCP server on demand via npx. For remote options or .NET-specific integrations, refer to Visual Studio's AI Toolkit documentation or Microsoft's MCP guides.

## Install in Crush

Crush is an AI-powered coding agent and development tool that supports the Model Context Protocol (MCP) for integrating external services like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance automated coding, debugging, and research tasks within Crush's agentic workflows.

### Prerequisites
- Crush installed on your system (download from official sources or via package managers if available; check Crush documentation for setup).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Crush's configuration interface or CLI for MCP management.

### Step-by-Step Installation
1. Open Crush and access the settings: Launch Crush and navigate to the Settings or Configuration panel (typically via a menu or command like `/settings` in the agent interface).

2. Navigate to MCP Servers: In the settings, find the "MCP Integrations" or "Tools" section to manage servers.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration file (e.g., `~/.crush/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable the Server: Toggle the Firecrawl server to enabled if required, and restart Crush to apply the configuration.

### Verification Steps
1. Restart Crush: Close and reopen the application to load the new MCP server.

2. Check MCP Status: In the settings or agent dashboard, verify that "firecrawl" is listed as active or connected (e.g., with a status check command like `/mcp list`).

3. Test with Sample Queries: Interact with Crush's agent or chat interface and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Crush AI agent updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Crush docs and extract MCP integration steps`

   Crush should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Crush's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or Crush-specific extensions, refer to Crush's MCP documentation or community resources.

## Install in BoltAI

BoltAI is an AI-powered macOS application for running local LLMs and agents, with support for the Model Context Protocol (MCP). Integrating Firecrawl MCP enables web scraping, crawling, and search tools to extend BoltAI's capabilities, allowing models to access web data for enhanced responses and agent tasks.

### Prerequisites
- BoltAI installed on your macOS system (download from https://boltai.com if needed).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to BoltAI's settings or configuration panel.

### Step-by-Step Installation
1. Open BoltAI and access the settings: Launch BoltAI and click the gear icon or go to Preferences via the menu.

2. Navigate to MCP or Tools Section: In the settings, find the "MCP Servers" or "Integrations" tab to manage external tools.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration JSON (typically at `~/Library/Application Support/BoltAI/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable in Agent or Chat: In a new chat or agent session, toggle on MCP tools or select Firecrawl from available integrations.

5. Restart BoltAI if prompted: Close and reopen the app to apply the configuration.

### Verification Steps
1. Check MCP Status: In the settings or tools panel, verify that "firecrawl" is listed as active or connected (e.g., with a green status indicator).

2. Test with Sample Queries: Start a chat in BoltAI and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for BoltAI updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the BoltAI docs and extract MCP integration steps`

   BoltAI should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

3. Check for Errors: If tools fail, review BoltAI's logs (accessible via the debug menu or console) for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or BoltAI-specific agents, refer to BoltAI's MCP documentation or community resources.

## Install in Rovo Dev CLI

Rovo Dev CLI is a command-line interface for Rovo's development tools, supporting the Model Context Protocol (MCP) to integrate AI capabilities like Firecrawl for web scraping, crawling, and search, enhancing dev workflows such as code generation and research directly in the terminal.

### Prerequisites
- Rovo Dev CLI installed and authenticated (follow official docs, e.g., via npm or download, and log in if required).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to a terminal or command prompt for running CLI commands.

### Step-by-Step Installation
1. Open your terminal or command prompt.

2. Use the Rovo Dev CLI command to add the Firecrawl MCP server:

   ```text
   rovo mcp add firecrawl --command "npx" --args "-y" "firecrawl-mcp" --env FIRECRAWL_API_KEY=your_api_key_here
   ```

   Replace `your_api_key_here` with your actual Firecrawl API key. This command configures the MCP server to run locally via npx and sets the environment variable for authentication.

3. Alternatively, manually edit the `settings.json` file: Locate or create `~/.rovo/settings.json` (user-wide) or `.rovo/settings.json` in your project root (project-specific). Add the following JSON block:

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the file.

4. If prompted during the process, follow any additional instructions for configuration or authentication.

### Verification Steps
1. Run the following command to list configured MCP servers and check status:

   ```text
   rovo mcp list
   ```

   Look for "firecrawl" in the list with a "CONNECTED" status. If disconnected, check logs with `rovo --debug` or verify the API key.

2. Use the `/mcp` command in a Rovo Dev CLI session to view server details, available tools (e.g., `firecrawl_scrape`, `firecrawl_search`), and discovery state.

3. Test with sample queries in the Rovo Dev CLI chat interface:
   - Search Example: `Search for Rovo Dev CLI updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the docs section of firecrawl.dev`

   The CLI should invoke the Firecrawl MCP server automatically, returning results like markdown content, summaries, or extracted data.

4. Check for errors: If tools fail, review Rovo Dev CLI logs for issues such as invalid API keys or connection problems. Ensure the API key is valid and has sufficient credits.

Note: This setup uses a local stdio MCP server launched on demand. For remote HTTP or SSE configurations, adapt using `rovo mcp add --transport http` with the hosted Firecrawl endpoint (e.g., https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp). Refer to Rovo Dev CLI documentation for advanced options like tool filtering or trust settings.

## Install in Zencoder

Zencoder is an AI-assisted coding tool or extension that supports the Model Context Protocol (MCP) for integrating external services like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance code encoding, automation, and development tasks within Zencoder's workflows.

### Prerequisites
- Zencoder installed on your system (download from official sources or via marketplaces if available; check Zencoder documentation for setup).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Zencoder's configuration interface or settings panel.

### Step-by-Step Installation
1. Open Zencoder and access the settings: Launch Zencoder and navigate to the Settings or Preferences panel (typically via a gear icon or menu option).

2. Navigate to MCP Servers: In the settings, find the "MCP Integrations" or "Tools" section to manage servers.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration file (e.g., `~/.zencoder/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable the Server: Toggle the Firecrawl server to enabled if required, and restart Zencoder to apply the configuration.

### Verification Steps
1. Restart Zencoder: Close and reopen the application to load the new MCP server.

2. Check MCP Status: In the settings or dashboard, verify that "firecrawl" is listed as active or connected (e.g., with a status indicator).

3. Test with Sample Queries: Interact with Zencoder's AI interface or chat and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Zencoder MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Zencoder docs and extract MCP integration steps`

   Zencoder should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Zencoder's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or Zencoder-specific features, refer to Zencoder's MCP documentation or community resources.

## Install in Qodo Gen

Qodo Gen is an AI-powered code generation tool that supports the Model Context Protocol (MCP) for integrating external services like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance code synthesis, automation, and development tasks within Qodo Gen's generative workflows.

### Prerequisites
- Qodo Gen installed on your system (download from official sources or via marketplaces if available; check Qodo Gen documentation for setup).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Qodo Gen's configuration interface or settings panel.

### Step-by-Step Installation
1. Open Qodo Gen and access the settings: Launch Qodo Gen and navigate to the Settings or Preferences panel (typically via a gear icon or menu option).

2. Navigate to MCP Servers: In the settings, find the "MCP Integrations" or "Tools" section to manage servers.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration file (e.g., `~/.qodogen/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable the Server: Toggle the Firecrawl server to enabled if required, and restart Qodo Gen to apply the configuration.

### Verification Steps
1. Restart Qodo Gen: Close and reopen the application to load the new MCP server.

2. Check MCP Status: In the settings or dashboard, verify that "firecrawl" is listed as active or connected (e.g., with a status indicator).

3. Test with Sample Queries: Interact with Qodo Gen's AI interface or chat and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Qodo Gen MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Qodo Gen docs and extract MCP integration steps`

   Qodo Gen should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Qodo Gen's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or Qodo Gen-specific features, refer to Qodo Gen's MCP documentation or community resources.

## Install in Perplexity Desktop

Perplexity Desktop is the desktop application for Perplexity AI, an AI-powered search engine and research tool that supports the Model Context Protocol (MCP). Adding Firecrawl MCP enables web scraping, crawling, and search tools to extend Perplexity's capabilities, allowing for deeper web data extraction and integration in desktop-based research workflows.

### Prerequisites
- Perplexity Desktop app installed on your system (download from the official Perplexity website or app store if available).
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to the Perplexity Desktop configuration directory (typically `~/.perplexity/` on macOS/Linux or `%APPDATA%\Perplexity` on Windows).
- Internet connection for initial setup and API calls (Perplexity Desktop may support offline modes, but MCP tools require online access).

### Step-by-Step Installation
1. Obtain your Firecrawl API key by signing up at https://firecrawl.dev/app and copying it from the dashboard.

2. Locate or create the configuration file: Navigate to the Perplexity Desktop config directory (e.g., `~/.perplexity/perplexity_desktop_config.json` on macOS/Linux). If the file doesn't exist, create it as a new JSON file.

3. Add the Firecrawl MCP configuration: Paste the following JSON into the file (or merge it if the file already has content):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "url": "https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_API_KEY"
         }
       }
     }
   }
   ```

   Replace both instances of `YOUR_API_KEY` with your actual Firecrawl API key. This setup uses Firecrawl's remote hosted MCP endpoint for easier integration without local server management.

4. Save the file and ensure the JSON is valid (no trailing commas or syntax errors).

### Verification Steps
1. Restart Perplexity Desktop: Close and reopen the application to load the new configuration.

2. Check MCP Integration: In Perplexity Desktop's settings or extensions menu (if available), look for MCP servers. Verify that "firecrawl" is listed and shows as connected or enabled.

3. Test with sample queries in a new Perplexity session:
   - Search Example: `Search the web for Perplexity Desktop MCP features`
   - Scrape Example: `Scrape https://firecrawl.dev and explain its purpose`
   - Crawl Example: `Crawl the Perplexity docs and summarize MCP support`

   Perplexity should automatically use the Firecrawl MCP tools, returning results such as summaries, markdown content, or extracted data from the web.

4. Check for Errors: If tools fail, review Perplexity Desktop's logs (accessible via the help menu or console) for issues like invalid API keys or connection errors. Ensure your Firecrawl API key is active and the hosted URL is reachable.

Note: This remote setup avoids local dependencies like Node.js, making it suitable for desktop environments. For local alternatives or advanced configurations, refer to Perplexity's MCP documentation or the Firecrawl repo for stdio-based options.

## Install in Factory

Factory is an AI-powered development platform or tool that supports the Model Context Protocol (MCP) for integrating external services like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance automated workflows, code generation, and data processing within Factory's factory-like production environment.

### Prerequisites
- Factory installed on your system (download from official sources or via marketplaces if available; check Factory documentation for setup).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Factory's configuration interface or settings panel.

### Step-by-Step Installation
1. Open Factory and access the settings: Launch Factory and navigate to the Settings or Preferences panel (typically via a gear icon or menu option).

2. Navigate to MCP Servers: In the settings, find the "MCP Integrations" or "Tools" section to manage servers.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration file (e.g., `~/.factory/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable the Server: Toggle the Firecrawl server to enabled if required, and restart Factory to apply the configuration.

### Verification Steps
1. Restart Factory: Close and reopen the application to load the new MCP server.

2. Check MCP Status: In the settings or dashboard, verify that "firecrawl" is listed as active or connected (e.g., with a status indicator).

3. Test with Sample Queries: Interact with Factory's AI interface or chat and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Factory MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Factory docs and extract MCP integration steps`

   Factory should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Factory's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or Factory-specific features, refer to Factory's MCP documentation or community resources.

## Install in Emdash

Emdash is an AI-assisted writing and productivity tool that supports the Model Context Protocol (MCP) for integrating external services like Firecrawl. This enables web scraping, crawling, and search capabilities to enhance content creation, research, and data integration within Emdash's dash-based workflows.

### Prerequisites
- Emdash installed on your system (download from official sources or via app stores if available; check Emdash documentation for setup).
- Node.js (version 16 or higher) and npm installed, as the setup uses npx to run the Firecrawl MCP package.
- A Firecrawl API key: Sign up at https://firecrawl.dev/app and copy your API key.
- Access to Emdash's configuration interface or settings panel.

### Step-by-Step Installation
1. Open Emdash and access the settings: Launch Emdash and navigate to the Settings or Preferences panel (typically via a gear icon or menu option).

2. Navigate to MCP Servers: In the settings, find the "MCP Integrations" or "Tools" section to manage servers.

3. Add the Firecrawl MCP Server: Click "Add Server" or edit the configuration file (e.g., `~/.emdash/config.json`). Paste the following JSON block into the "mcpServers" section (merge if it exists):

   ```json
   {
     "mcpServers": {
       "firecrawl": {
         "command": "npx",
         "args": [
           "-y",
           "firecrawl-mcp"
         ],
         "env": {
           "FIRECRAWL_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

   Replace `"your_api_key_here"` with your actual Firecrawl API key. Save the changes.

4. Enable the Server: Toggle the Firecrawl server to enabled if required, and restart Emdash to apply the configuration.

### Verification Steps
1. Restart Emdash: Close and reopen the application to load the new MCP server.

2. Check MCP Status: In the settings or dashboard, verify that "firecrawl" is listed as active or connected (e.g., with a status indicator).

3. Test with Sample Queries: Interact with Emdash's AI interface or chat and enter queries that utilize Firecrawl tools:
   - Search Example: `Search for Emdash MCP updates in 2025`
   - Scrape Example: `Scrape https://firecrawl.dev and summarize features`
   - Crawl Example: `Crawl the Emdash docs and extract MCP integration steps`

   Emdash should invoke the Firecrawl MCP server automatically, returning results such as summaries, markdown content, or extracted data.

4. Check for Errors: If tools fail, review Emdash's logs or console output for issues like invalid API keys or server startup problems. Ensure the API key is valid and Node.js is properly installed.

Note: This local setup runs the MCP server on demand via npx. For remote configurations or Emdash-specific features, refer to Emdash's MCP documentation or community resources.
