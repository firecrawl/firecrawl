/**
 * Prompt-mode interact timeout semantics. The request `timeout` is documented
 * as "Execution timeout in seconds" and the SDKs abort around it, but the
 * agent loop used to pass it to every browser command, so one prompt call
 * could run for up to MAX_STEPS × timeout. These tests pin the total-budget
 * behavior: each command's timeout is capped at the remaining budget and the
 * loop stops once the budget is spent.
 */
const agentMocks = vi.hoisted(() => ({
  execCalls: [] as { code: string; timeout: number; language?: string }[],
  runAgent: undefined as undefined | ((args: any) => Promise<any>),
  onExec: undefined as
    | undefined
    | ((opts: { code: string; timeout: number; language?: string }) => void),
}));

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      IS_PRODUCTION: true,
      VERTEX_CREDENTIALS: undefined,
    },
  };
});

vi.mock("../logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const child = vi.fn(() => ({ ...log, child }));
  return { logger: { ...log, child } };
});

vi.mock("../generic-ai", () => ({
  getModel: vi.fn(() => ({})),
}));

vi.mock("../us-only", () => ({
  isUsOnly: () => false,
}));

vi.mock("../hangar", () => ({
  executeHangarBrowser: vi.fn(
    async (
      _browserId: string,
      opts: { code: string; timeout: number; language?: string },
    ) => {
      agentMocks.onExec?.(opts);
      agentMocks.execCalls.push({
        code: opts.code,
        timeout: opts.timeout,
        language: opts.language,
      });
      if (opts.language === "node") {
        // selectBrowserAgentTab expects a 32-char hex CDP target id.
        return { exitCode: 0, stdout: "ab".repeat(16), killed: false };
      }
      return { exitCode: 0, stdout: "", result: "", killed: false };
    },
  ),
}));

vi.mock("./langsmith", () => ({
  generateText: (...args: [unknown]) => agentMocks.runAgent!(...args),
  buildLangSmithProviderOptions: vi.fn(() => undefined),
  traceInteract: (fn: any) => fn,
}));

import { executePromptViaBrowserAgent } from "./browser-agent";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function toolCallsFor(...codes: string[]) {
  return agentMocks.execCalls.filter(c => codes.includes(c.code));
}

describe("executePromptViaBrowserAgent timeout budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    agentMocks.execCalls.length = 0;
    agentMocks.onExec = undefined;
    agentMocks.runAgent = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps each browser command at the remaining request timeout", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // The first command consumed 8 of the 10 allowed seconds.
      vi.setSystemTime(Date.now() + 8000);
      await browser.execute({ code: "agent-browser click @e1" });
      vi.setSystemTime(Date.now() + 1000);
      return { text: "done" };
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    expect(result.exitCode).toBe(0);
    const [snap, click] = toolCallsFor(
      "agent-browser snapshot",
      "agent-browser click @e1",
    );
    expect(snap.timeout).toBe(10);
    // Only ~2s remained when the second command started.
    expect(click.timeout).toBe(2);
  });

  it("refuses browser commands once the total budget is spent", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      vi.setSystemTime(Date.now() + 6000);
      await browser.execute({ code: "agent-browser click @e1" });
      // Past the 10s budget: the loop must not execute another command.
      vi.setSystemTime(Date.now() + 6000);
      await expect(
        browser.execute({ code: "agent-browser get url" }),
      ).rejects.toThrow(/timed out/i);
      return { text: "done" };
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    // Setup runs one `get url` probe; the past-deadline tool call must never
    // reach the browser.
    expect(
      agentMocks.execCalls.filter(c => c.code === "agent-browser get url")
        .length,
    ).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("clamps the per-command timeout to a one-second floor", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // 9.6s elapsed: only 0.4s remain, but a command still gets 1s.
      vi.setSystemTime(Date.now() + 9600);
      await browser.execute({ code: "agent-browser click @e1" });
      return { text: "done" };
    };

    await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    const [, click] = toolCallsFor(
      "agent-browser snapshot",
      "agent-browser click @e1",
    );
    expect(click.timeout).toBe(1);
  });

  it("reports a clear message when the deadline aborts the model call", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const seen: { abortSignal?: unknown } = {};
    agentMocks.runAgent = async (args: any) => {
      seen.abortSignal = args.abortSignal;
      throw timeoutErr;
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    // The model call runs under the deadline-based abort signal.
    expect(seen.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Prompt execution timed out after 10s.");
  });

  it("caps the setup probes at the remaining budget", async () => {
    agentMocks.onExec = opts => {
      // The tab-visibility probe burns 6 of the 10 allowed seconds.
      if (opts.language === "node") {
        vi.setSystemTime(Date.now() + 6000);
      }
    };
    agentMocks.runAgent = async () => ({ text: "done" });

    await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    const tabSelect = agentMocks.execCalls.find(c =>
      c.code.startsWith("agent-browser tab "),
    );
    const snapshotProbe = agentMocks.execCalls.find(
      c => c.code === "agent-browser snapshot -i",
    );
    const urlProbe = agentMocks.execCalls.find(
      c => c.code === "agent-browser get url",
    );
    // 4s remain when the tab selection and probes start.
    expect(tabSelect?.timeout).toBe(4);
    expect(snapshotProbe?.timeout).toBe(4);
    expect(urlProbe?.timeout).toBe(4);
  });

  it("reports the timeout without a model call when setup spends the budget", async () => {
    agentMocks.onExec = opts => {
      if (opts.code === "agent-browser snapshot -i") {
        vi.setSystemTime(Date.now() + 11000);
      }
    };
    let modelCalled = false;
    agentMocks.runAgent = async () => {
      modelCalled = true;
      return { text: "done" };
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    expect(modelCalled).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Prompt execution timed out after 10s.");
  });

  it("bounds tab re-selection by the remaining budget", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      vi.setSystemTime(Date.now() + 6000);
      await browser.execute({ code: "agent-browser click @e1" });
      return { text: "done" };
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    const nodeExecs = agentMocks.execCalls.filter(c => c.language === "node");
    // Setup selection + re-selection after each of the two commands; the
    // one after the click runs with 4s left, not the fixed 10s.
    expect(nodeExecs.length).toBe(3);
    expect(nodeExecs[2].timeout).toBe(4);
    expect(result.exitCode).toBe(0);
  });

  it("skips tab re-selection once the budget is spent", async () => {
    agentMocks.onExec = opts => {
      // The click outlives the budget while it runs.
      if (opts.code === "agent-browser click @e1" && opts.language === "bash") {
        vi.setSystemTime(Date.now() + 2000);
      }
    };
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // 8s spent: the click runs with the last 2s and finishes past the
      // deadline, so its re-selection must be skipped.
      vi.setSystemTime(Date.now() + 8000);
      await browser.execute({ code: "agent-browser click @e1" });
      return { text: "done" };
    };

    const result = await executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      10,
      logger,
      undefined,
    );

    const nodeExecs = agentMocks.execCalls.filter(c => c.language === "node");
    // Setup selection + re-selection after the snapshot only.
    expect(nodeExecs.length).toBe(2);
    expect(result.exitCode).toBe(0);
  });
});
