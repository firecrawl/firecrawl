import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { tool, stepCountIs } from "ai";
import { logger as _logger } from "../logger";
import { getModel } from "../generic-ai";
import {
  browserServiceRequest,
  BrowserServiceExecResponse,
} from "./browser-service-client";
import { config } from "../../config";
import {
  generateText,
  buildLangSmithProviderOptions,
  traceInteract,
  InteractTraceMetadata,
} from "./langsmith";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STEPS = 25;
const SNAPSHOT_TIMEOUT = 15;
const SNAPSHOT_MAX_CHARS = 40_000;

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

const AGENT_LOG_DIR = path.join(
  __dirname,
  "../../logs/scrape-interact-agent-logs",
);

const IS_PRODUCTION = config.IS_PRODUCTION === true;

class AgentDebugLog {
  private filePath: string;
  private lines: string[] = [];
  private enabled: boolean;

  constructor(browserId: string) {
    this.enabled = !IS_PRODUCTION;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(AGENT_LOG_DIR, `${ts}_${browserId}.log`);
  }

  add(text: string) {
    if (!this.enabled) return;
    this.lines.push(text);
  }

  async flush() {
    if (!this.enabled || this.lines.length === 0) return;
    try {
      await fs.mkdir(AGENT_LOG_DIR, { recursive: true });
      await fs.appendFile(this.filePath, this.lines.join("\n") + "\n");
      this.lines = [];
    } catch (err) {
      _logger.error("AgentDebugLog flush failed", {
        filePath: this.filePath,
        agentLogDir: AGENT_LOG_DIR,
        error: err,
      });
    }
  }

  getPath() {
    return this.filePath;
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You complete tasks by interacting with a browser using the browser tool. Be autonomous — break tasks into steps, execute ALL steps without stopping early, and be concise.

## Browser Tool — agent-browser commands
The browser tool runs agent-browser CLI commands. Each tool call should contain a single command or a short chain (joined with &&).

Commands:
  agent-browser snapshot                Get full accessibility tree with clickable refs (@e1, @e2...), prefer using -i
  agent-browser snapshot -i             Only interactive elements
  agent-browser snapshot -s "#css"      Scope snapshot to a CSS selector
  agent-browser click @e1               Click element by ref
  agent-browser fill @e2 "text"         Clear field and type text
  agent-browser type @e2 "text"         Type without clearing
  agent-browser select @e1 "option"     Select dropdown option
  agent-browser check @e1               Toggle checkbox
  agent-browser press Enter             Press a key
  agent-browser keyboard type "text"    Type at current focus
  agent-browser hover @e1               Hover element
  agent-browser scroll down 500         Scroll down (px)
  agent-browser scroll up 500           Scroll up (px)
  agent-browser get text @e1            Get text content of element
  agent-browser get title               Get page title
  agent-browser get url                 Get current URL
  agent-browser wait @e1                Wait for element to appear
  agent-browser wait --load networkidle Wait for network idle
  agent-browser wait --text "Welcome"   Wait for text to appear
  agent-browser wait 2000               Wait milliseconds
  agent-browser find text "X" click     Find element by text and click
  agent-browser find role button click --name "Submit"
  agent-browser find placeholder "Q" type "query"
  agent-browser frame @e2               Scope to iframe
  agent-browser frame main              Return to main frame
  agent-browser eval "js code"          Run JavaScript in page
  agent-browser back                    Go back

## Workflow
1. An initial page snapshot is provided — use it immediately, don't re-snapshot.
2. Interact with elements using @refs from the snapshot.
3. After interactions that change the page, call snapshot to see the updated state.
4. Use the new @refs from the latest snapshot for further interactions.
5. Repeat until the task is complete.

## Rules
1. You are already on the target page. Do NOT navigate to external sites or search engines.
2. @refs are invalidated after page changes — always snapshot again after interactions.
3. Chain independent commands with && to save round-trips.
4. When extracting data, use agent-browser get text or agent-browser eval to pull content.
5. If a command fails, try a different approach (different selector, wait first, use find, etc.).
6. NEVER open new tabs. Always work in the current tab. Do not use agent-browser tab new or agent-browser open. If you need to navigate within the site, click links directly.

## Output Format
Your final text response is what the user sees. It MUST be a clean, human-readable answer:
- If asked for a price → respond with the product name and price (e.g. "iPhone 15 Pro Max: $1,199")
- If asked for a list → respond with a clean list of items
- If asked to perform an action → confirm what was done
- NEVER dump raw HTML, accessibility trees, or @ref identifiers in your final response
- Be concise and direct — just the answer the user asked for`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface AgentResult extends BrowserServiceExecResponse {
  output: string;
}

async function execInBrowser(
  browserId: string,
  code: string,
  timeout: number,
  origin: string,
): Promise<BrowserServiceExecResponse> {
  return browserServiceRequest<BrowserServiceExecResponse>(
    "POST",
    `/browsers/${browserId}/exec`,
    { code, language: "bash", timeout, origin },
  );
}

async function getCurrentUrl(browserId: string): Promise<string> {
  try {
    const result = await execInBrowser(
      browserId,
      "agent-browser get url",
      SNAPSHOT_TIMEOUT,
      "agent_get_url",
    );
    return (result.stdout || result.result || "").trim();
  } catch {
    return "";
  }
}

async function takeSnapshot(browserId: string): Promise<string> {
  try {
    const result = await execInBrowser(
      browserId,
      "agent-browser snapshot -i",
      SNAPSHOT_TIMEOUT,
      "agent_snapshot",
    );
    return (result.stdout || result.result || "").slice(0, SNAPSHOT_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * Keep a single foregrounded content tab, closing agent-browser's stray
 * about:blank tab (it safely falls back to the surviving tab).
 */
async function syncTabs(browserId: string): Promise<void> {
  try {
    await browserServiceRequest("POST", `/browsers/${browserId}/exec`, {
      code: [
        `const ctx = page.context();`,
        `const pages = ctx.pages();`,
        `if (pages.length > 1) {`,
        `  const target = pages.find(p => { const u = p.url(); return u && u !== 'about:blank'; }) || pages[pages.length - 1];`,
        `  for (const p of pages) { if (p !== target) await p.close().catch(() => {}); }`,
        `  page = target;`,
        `}`,
        `await page.bringToFront();`,
      ].join("\n"),
      language: "node",
      timeout: 5,
      origin: "tab_sync",
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Main agent — tool-calling loop via AI SDK
// ---------------------------------------------------------------------------

interface BrowserAgentTraceContext {
  sessionId: string;
  scrapeId: string;
  teamId: string;
  orgId?: string;
  zeroDataRetention?: boolean;
  scrapeUrl?: string;
  targetUrl?: string;
  scrapeWaitForMs?: number;
  scrapeActions?: number;
  scrapeOrigin?: string;
}

export async function executePromptViaBrowserAgent(
  prompt: string,
  browserId: string,
  stepTimeout: number,
  logger: typeof _logger,
  trace?: BrowserAgentTraceContext,
): Promise<AgentResult> {
  const debugLog = new AgentDebugLog(browserId);
  debugLog.add(`=== AGENT RUN ===`);
  debugLog.add(`Time:    ${new Date().toISOString()}`);
  debugLog.add(`Browser: ${browserId}`);
  debugLog.add(`Prompt:  ${prompt}\n`);
  logger.info("Agent debug log", { path: debugLog.getPath() });

  // Prime agent-browser and consolidate tabs first: its first command of a
  // session spawns an about:blank tab that would otherwise get snapshotted.
  await getCurrentUrl(browserId);
  await syncTabs(browserId);

  const [initialSnapshot, initialUrl] = await Promise.all([
    takeSnapshot(browserId),
    getCurrentUrl(browserId),
  ]);

  debugLog.add(`URL: ${initialUrl}`);
  debugLog.add(
    `Snapshot (${initialSnapshot.length} chars):\n${initialSnapshot || "(empty)"}\n`,
  );
  debugLog.flush();

  let toolCallCount = 0;
  const allOutputs: string[] = [];
  let lastSnapshotResult = initialSnapshot;
  const actionLog: string[] = [];

  const browserTool = tool({
    description:
      "Run an agent-browser CLI command in the browser. Each call should be one command or a short && chain.",
    inputSchema: z.object({
      code: z.string().describe("The agent-browser command(s) to execute"),
    }),
    execute: async ({ code }) => {
      toolCallCount++;
      const start = Date.now();
      debugLog.add(`--- [${toolCallCount}] ${code} ---`);

      if (/agent-browser\s+(tab\s+new|open\s)/.test(code)) {
        const msg =
          "Blocked: opening new tabs/URLs is not allowed. Use click to navigate within the site.";
        debugLog.add(`BLOCKED: ${msg}\n`);
        actionLog.push(`${toolCallCount}. ${code} → BLOCKED`);
        return { error: msg };
      }

      try {
        const result = await execInBrowser(
          browserId,
          code,
          stepTimeout,
          "agent_action",
        );
        const output = (result.stdout || result.result || "").trim();

        // Ensure only one tab exists and it's in the foreground for live view
        await syncTabs(browserId);

        const elapsed = Date.now() - start;

        debugLog.add(`Exit: ${result.exitCode} (${elapsed}ms)`);
        if (output) debugLog.add(`Output:\n${output}`);
        if (result.stderr) debugLog.add(`Stderr:\n${result.stderr}`);
        debugLog.add("");
        debugLog.flush();

        if (code.includes("snapshot")) lastSnapshotResult = output;
        if (output) allOutputs.push(output);

        const brief = code.includes("snapshot")
          ? `(${output.length} chars)`
          : (output || result.stderr || "").slice(0, 120);
        const status =
          result.exitCode === 0 ? "OK" : `FAIL(${result.exitCode})`;
        actionLog.push(`${toolCallCount}. ${code} → ${status}: ${brief}`);

        if (result.exitCode !== 0) {
          return {
            error: result.stderr || "Command failed",
            exit_code: result.exitCode,
            output,
          };
        }
        return { result: output || "(no output)" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog.add(`Error: ${msg}\n`);
        debugLog.flush();
        actionLog.push(
          `${toolCallCount}. ${code} → ERROR: ${msg.slice(0, 120)}`,
        );
        return { error: msg };
      }
    },
  });

  const langsmith = trace
    ? buildLangSmithProviderOptions(
        {
          thread_id: trace.sessionId,
          session_id: trace.sessionId,
          scrape_id: trace.scrapeId,
          team_id: trace.teamId,
          org_id: trace.orgId,
          browser_id: browserId,
          mode: "prompt",
          zeroDataRetention: trace.zeroDataRetention,
          scrape_url: trace.scrapeUrl,
          target_url: trace.targetUrl,
          scrape_wait_for_ms: trace.scrapeWaitForMs,
          scrape_actions: trace.scrapeActions,
          scrape_origin: trace.scrapeOrigin,
        } satisfies InteractTraceMetadata,
        {
          name: "interact:prompt",
          extra: { prompt_length: prompt.length },
        },
      )
    : undefined;

  try {
    const result = await generateText({
      model: getModel("gemini-3.5-flash", "google"),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `Current URL: ${initialUrl || "(unknown)"}\n\nPage snapshot:\n${initialSnapshot || "(empty — page may still be loading)"}\n\nTask: ${prompt}`,
            },
          ],
        },
      ],
      tools: { browser: browserTool },
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
      // LangSmith's provider-options object is recognized by wrapAISDK but
      // does not satisfy AI SDK's SharedV3ProviderOptions shape, hence the
      // local cast — keeps the rest of the type surface strict.
      ...(langsmith
        ? { providerOptions: { langsmith } as Record<string, any> }
        : {}),
      prepareStep: async ({ stepNumber, messages }) => {
        if (actionLog.length === 0) return {};
        return {
          messages: [
            ...messages,
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `ACTION LOG (your commands so far):\n${actionLog.join("\n")}\n\nReview this log before your next action. Common mistakes to check for:\n- Typed text but forgot to press Enter\n- Clicked a link but didn't wait or re-snapshot\n- Used stale @refs from a previous snapshot\n- Scrolled but didn't snapshot to see new content`,
                },
              ],
            },
          ],
        };
      },
      onStepFinish: ({ text, toolCalls }) => {
        if (toolCalls?.length) {
          debugLog.add(`[Step: ${toolCalls.length} tool call(s)]`);
        }
        if (text) debugLog.add(`Assistant: ${text}`);
      },
    });

    debugLog.add(`\n=== END: completed (${toolCallCount} tool calls) ===\n`);
    await debugLog.flush();

    return {
      output: result.text || "",
      stdout: allOutputs.join("\n"),
      result: lastSnapshotResult,
      stderr: "",
      exitCode: 0,
      killed: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Agent failed", { error: err });
    debugLog.add(`\n=== END: error — ${msg} ===\n`);
    await debugLog.flush();

    return {
      output: "",
      stdout: allOutputs.join("\n"),
      result: lastSnapshotResult,
      stderr: msg,
      exitCode: 1,
      killed: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Code path — direct exec wrapped with the same trace metadata shape as the
// prompt path, so tracing details don't have to live in the controller.
// ---------------------------------------------------------------------------

export async function executeCodeViaBrowserSession(
  browserId: string,
  params: {
    code: string;
    language: string;
    timeout: number;
    origin?: string;
  },
  trace?: BrowserAgentTraceContext,
): Promise<BrowserServiceExecResponse> {
  // Arg must be named so langsmith's traceable sees the exec params as the
  // run's `inputs`; a zero-arg closure would record `{}` and strip the code,
  // language, timeout, and origin from every trace.
  const run = async (execParams: typeof params) =>
    browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${browserId}/exec`,
      execParams,
    );

  if (!trace) return run(params);

  const traced = traceInteract(
    run,
    {
      thread_id: trace.sessionId,
      session_id: trace.sessionId,
      scrape_id: trace.scrapeId,
      team_id: trace.teamId,
      org_id: trace.orgId,
      browser_id: browserId,
      mode: "code",
      zeroDataRetention: trace.zeroDataRetention,
      scrape_url: trace.scrapeUrl,
      target_url: trace.targetUrl,
      scrape_wait_for_ms: trace.scrapeWaitForMs,
      scrape_actions: trace.scrapeActions,
      scrape_origin: trace.scrapeOrigin,
    } satisfies InteractTraceMetadata,
    { name: "interact:code" },
  );

  return traced(params);
}
