/**
 * Prompt-mode interact timeout semantics. The request `timeout` is an
 * execution budget in seconds, but the prompt loop used to pass it to each
 * browser command. Exercise the shared deadline from setup through model/tool
 * execution without network services.
 */
const agentMocks = vi.hoisted(() => ({
  execCalls: [] as { code: string; timeout: number; language?: string }[],
  runAgent: undefined as undefined | ((args: any) => Promise<any>),
  runUntraced: vi.fn(),
  appendDebugLog: vi.fn(async (_path: string, _data: string) => {}),
  traceOptions: vi.fn(),
  onModelOptions: undefined as (() => void) | undefined,
  onExec: undefined as
    | undefined
    | ((opts: {
        code: string;
        timeout: number;
        language?: string;
      }) => void | Promise<void>),
}));

vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn(async () => {}),
      appendFile: agentMocks.appendDebugLog,
    },
  };
});

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      IS_PRODUCTION: false,
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

vi.mock("../../service", () => ({
  service: {
    // No LLM provider is registered in unit tests, so browser-agent takes
    // the default-provider path (getModel is mocked above regardless).
    llmProviders: { get: (_name: string) => undefined },
  },
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
      agentMocks.execCalls.push({
        code: opts.code,
        timeout: opts.timeout,
        language: opts.language,
      });
      await agentMocks.onExec?.(opts);
      if (opts.language === "node") {
        // selectBrowserAgentTab expects a 32-char hex CDP target id.
        return { exitCode: 0, stdout: "ab".repeat(16), killed: false };
      }
      const stdout =
        opts.code === "agent-browser snapshot -i"
          ? "initial snapshot"
          : opts.code === "agent-browser snapshot"
            ? "updated snapshot"
            : "";
      return { exitCode: 0, stdout, result: "", killed: false };
    },
  ),
}));

vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (args: unknown) => agentMocks.runUntraced(args),
    isStepCount: (count: number) => {
      agentMocks.onModelOptions?.();
      return actual.isStepCount(count);
    },
  };
});

vi.mock("./langsmith", () => ({
  generateText: (...args: [unknown]) => agentMocks.runAgent!(...args),
  buildLangSmithProviderOptions: agentMocks.traceOptions,
  traceInteract: (fn: any) => fn,
}));

import {
  executeCodeViaBrowserSession,
  executePromptViaBrowserAgent,
  selectBrowserAgentTab,
} from "./browser-agent";

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
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    agentMocks.execCalls.length = 0;
    agentMocks.onExec = undefined;
    agentMocks.onModelOptions = undefined;
    agentMocks.runAgent = undefined;
    agentMocks.runUntraced.mockReset();
    agentMocks.appendDebugLog.mockReset();
    agentMocks.traceOptions.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("caps each browser command at the remaining request timeout", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // The first command consumed 8 of the 10 allowed seconds.
      vi.advanceTimersByTime(8000);
      await browser.execute({ code: "agent-browser click @e1" });
      vi.advanceTimersByTime(1000);
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
    let lateCommand!: Promise<unknown>;
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      vi.advanceTimersByTime(6000);
      await browser.execute({ code: "agent-browser click @e1" });
      // Past the 10s budget: the loop must not execute another command.
      vi.advanceTimersByTime(6000);
      lateCommand = browser.execute({ code: "agent-browser get url" });
      await lateCommand;
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
    expect(result.exitCode).toBe(1);
    await expect(lateCommand).rejects.toThrow(/timed out/i);
  });

  it("clamps the per-command timeout to a one-second floor", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // 9.6s elapsed: only 0.4s remain, but a command still gets 1s.
      vi.advanceTimersByTime(9600);
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

  it("aborts the model at the remaining fractional budget and ignores a late answer", async () => {
    agentMocks.onExec = opts => {
      if (opts.language === "node") vi.advanceTimersByTime(600);
    };
    let signal: AbortSignal | undefined;
    let finishModel!: (result: { text: string }) => void;
    agentMocks.runAgent = ({ abortSignal }) => {
      signal = abortSignal;
      return new Promise(resolve => {
        finishModel = resolve;
      });
    };
    const completed = vi.fn();
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1.5,
      logger,
    );
    void run.then(completed);

    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(899);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const abortedAtDeadline = signal?.aborted;
    const settledAtDeadline = completed.mock.calls.length;
    finishModel({ text: "late answer" });

    expect(await run).toMatchObject({
      output: "",
      result: "initial snapshot",
      exitCode: 1,
      stderr: "Prompt execution timed out after 1.5s.",
      killed: false,
    });
    expect(abortedAtDeadline).toBe(true);
    expect(settledAtDeadline).toBe(1);
  });

  it.each([
    [undefined, "initial snapshot"],
    ["agent-browser get title", "initial snapshot"],
    ["agent-browser snapshot", "updated snapshot"],
  ])(
    "preserves the snapshot in the result after tool call %s",
    async (code, result) => {
      agentMocks.runAgent = async ({ tools }) => {
        if (code) await tools.browser.execute({ code });
        return { text: "done" };
      };
      expect(
        await executePromptViaBrowserAgent(
          "get the price",
          "browser-1",
          10,
          logger,
        ),
      ).toMatchObject({ exitCode: 0, output: "done", result });
    },
  );

  it("does not let a timer wake-up before the monotonic deadline abort the model", async () => {
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now");
    let finish!: (value: { text: string }) => void;
    let signal!: AbortSignal;
    agentMocks.runAgent = ({ abortSignal }) => {
      signal = abortSignal;
      return new Promise(resolve => {
        finish = resolve;
      });
    };
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1,
      logger,
    );
    await vi.advanceTimersByTimeAsync(0);
    clock.mockImplementation(() => now() - 1);
    await vi.advanceTimersByTimeAsync(1000);
    const abortedEarly = signal.aborted;
    finish({ text: "on time" });
    expect(await run).toMatchObject({ exitCode: 0, output: "on time" });
    expect(abortedEarly).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [999, 0],
    [1000, 1],
  ])(
    "checks the deadline after preparing model options at %dms",
    async (elapsed, exitCode) => {
      const generate = vi.fn(async () => ({ text: "done" }));
      agentMocks.runAgent = generate;
      agentMocks.onModelOptions = () => {
        vi.spyOn(performance, "now").mockReturnValue(elapsed);
      };

      const result = await executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
      );

      expect(result).toMatchObject({
        exitCode,
        output: exitCode === 0 ? "done" : "",
        stderr: exitCode === 0 ? "" : "Prompt execution timed out after 1s.",
      });
      expect(generate).toHaveBeenCalledTimes(exitCode === 0 ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a late model answer even before the deadline timer is serviced", async () => {
    let finish!: (value: { text: string }) => void;
    let signal!: AbortSignal;
    agentMocks.runAgent = ({ abortSignal }) => {
      signal = abortSignal;
      return new Promise(resolve => {
        finish = resolve;
      });
    };
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1,
      logger,
    );
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, "now").mockReturnValue(1000);
    finish({ text: "too late" });
    expect(await run).toMatchObject({
      exitCode: 1,
      stderr: "Prompt execution timed out after 1s.",
    });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "provider failure", "deadline"] as const)(
    "does not wait for debug log I/O after %s",
    async outcome => {
      let release!: () => void;
      const pendingWrite = new Promise<void>(resolve => {
        release = resolve;
      });
      const finalWrite = vi.fn();
      agentMocks.appendDebugLog.mockImplementation(async (_path, data) => {
        if (data.includes("=== END:")) {
          finalWrite();
          await pendingWrite;
        }
      });
      agentMocks.runAgent = async () => {
        if (outcome === "success") return { text: "done" };
        if (outcome === "provider failure")
          throw new Error("provider failed early");
        await pendingWrite;
        return { text: "late answer" };
      };
      const completed = vi.fn();
      const run = executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
      );
      void run.then(completed);
      try {
        await vi.advanceTimersByTimeAsync(outcome === "deadline" ? 1000 : 0);
        expect(finalWrite).toHaveBeenCalled();
        expect(completed).toHaveBeenCalledWith(
          expect.objectContaining({
            exitCode: outcome === "success" ? 0 : 1,
            stderr:
              outcome === "deadline"
                ? "Prompt execution timed out after 1s."
                : outcome === "provider failure"
                  ? "provider failed early"
                  : "",
          }),
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
        await run;
      }
    },
  );

  it.each(["success", "deadline"] as const)(
    "keeps debug log batches ordered when setup logging stalls before %s",
    async outcome => {
      let releaseSetupWrite!: () => void;
      let rejectSetupWrite!: (err: Error) => void;
      const setupWrite = new Promise<void>((resolve, reject) => {
        releaseSetupWrite = resolve;
        rejectSetupWrite = reject;
      });
      agentMocks.appendDebugLog.mockImplementationOnce(() => setupWrite);
      let finishModel: (() => void) | undefined;
      agentMocks.runAgent = async ({ tools }) => {
        await tools.browser.execute({ code: "agent-browser snapshot" });
        if (outcome === "deadline") {
          await new Promise<void>(resolve => {
            finishModel = resolve;
          });
        }
        return { text: "done" };
      };
      const completed = vi.fn();
      const run = executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
      );
      void run.then(completed);

      try {
        await vi.advanceTimersByTimeAsync(outcome === "deadline" ? 1000 : 0);
        expect(completed).toHaveBeenCalledWith(
          expect.objectContaining({
            exitCode: outcome === "success" ? 0 : 1,
            stderr:
              outcome === "success"
                ? ""
                : "Prompt execution timed out after 1s.",
          }),
        );
        expect(agentMocks.appendDebugLog).toHaveBeenCalledTimes(1);
      } finally {
        if (outcome === "success") releaseSetupWrite();
        else rejectSetupWrite(new Error("setup write failed"));
        finishModel?.();
        await run;
      }

      await vi.advanceTimersByTimeAsync(0);
      const writes = agentMocks.appendDebugLog.mock.calls.map(
        ([, data]) => data,
      );
      expect(writes).toHaveLength(3);
      expect(writes[0]).toContain("=== AGENT RUN ===");
      expect(writes[0]).not.toContain("updated snapshot");
      expect(writes[1]).toContain("updated snapshot");
      expect(writes[1]).not.toContain("=== AGENT RUN ===");
      expect(writes[2]).toContain(
        outcome === "success" ? "=== END: completed" : "=== END: error",
      );
      expect(writes[2]).not.toContain("updated snapshot");
    },
  );

  it.each([999, 1000])(
    "classifies a trace setup rejection observed at %dms",
    async elapsed => {
      agentMocks.traceOptions.mockImplementation(() => {
        vi.spyOn(performance, "now").mockReturnValue(elapsed);
        throw new Error("trace setup failed");
      });
      const generate = vi.fn();
      agentMocks.runAgent = generate;
      const run = executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
        { sessionId: "session-1", scrapeId: "scrape-1", teamId: "team-1" },
      );
      if (elapsed < 1000) {
        await expect(run).rejects.toThrow("trace setup failed");
      } else {
        await expect(run).resolves.toMatchObject({
          output: "",
          result: "initial snapshot",
          exitCode: 1,
          stderr: "Prompt execution timed out after 1s.",
          killed: false,
        });
      }
      expect(toolCallsFor("agent-browser snapshot -i")).toHaveLength(1);
      expect(generate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([999, 1000])(
    "checks the deadline when reading model text at %dms",
    async elapsed => {
      let signal!: AbortSignal;
      agentMocks.runAgent = async ({ abortSignal }) => {
        signal = abortSignal;
        return {
          get text() {
            vi.spyOn(performance, "now").mockReturnValue(elapsed);
            return "done";
          },
        };
      };
      const result = await executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
      );
      const expired = elapsed === 1000;
      expect(result).toMatchObject({
        output: expired ? "" : "done",
        exitCode: expired ? 1 : 0,
        stderr: expired ? "Prompt execution timed out after 1s." : "",
      });
      expect(signal.aborted).toBe(expired);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the same deadline for the untraced model path", async () => {
    agentMocks.runUntraced.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        }),
    );
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1,
      logger,
      {
        sessionId: "session-1",
        scrapeId: "scrape-1",
        teamId: "team-1",
        zeroDataRetention: true,
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(agentMocks.runUntraced).toHaveBeenCalledOnce();
    expect(await run).toMatchObject({
      exitCode: 1,
      stderr: "Prompt execution timed out after 1s.",
    });
  });

  it.each([30, 300])(
    "completes with a %ss budget despite a wall-clock jump",
    async timeout => {
      agentMocks.onExec = ({ language }) => {
        if (language === "node") vi.setSystemTime(Date.now() + 600_000);
      };
      agentMocks.runAgent = async ({ tools }) => {
        await tools.browser.execute({ code: "agent-browser snapshot" });
        return { text: "done" };
      };
      const result = await executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        timeout,
        logger,
      );
      expect(result).toMatchObject({ output: "done", stderr: "", exitCode: 0 });
      expect(toolCallsFor("agent-browser snapshot")[0]?.timeout).toBe(timeout);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["Error", "AbortError", "TimeoutError"])(
    "preserves a provider %s before the deadline",
    async name => {
      agentMocks.runAgent = async () => {
        const error = new Error("provider failed early");
        error.name = name;
        throw error;
      };
      expect(
        await executePromptViaBrowserAgent(
          "get the price",
          "browser-1",
          10,
          logger,
        ),
      ).toMatchObject({
        exitCode: 1,
        stderr: "provider failed early",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["target lookup", "await (async"],
    ["tab selection", "agent-browser tab "],
    ["snapshot", "agent-browser snapshot -i"],
    ["URL probe", "agent-browser get url"],
  ])("times out while the initial %s is pending", async (_stage, prefix) => {
    let finish!: () => void;
    agentMocks.onExec = ({ code }) => {
      if (code.startsWith(prefix))
        return new Promise<void>(resolve => {
          finish = resolve;
        });
    };
    agentMocks.runAgent = vi.fn(async () => ({ text: "done" }));
    const completed = vi.fn();
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1,
      logger,
    );
    void run.then(completed);
    await vi.advanceTimersByTimeAsync(999);
    const count = agentMocks.execCalls.length;
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const settledAtDeadline = completed.mock.calls.length;
    finish();

    expect(await run).toMatchObject({
      exitCode: 1,
      stderr: "Prompt execution timed out after 1s.",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settledAtDeadline).toBe(1);
    expect(agentMocks.execCalls).toHaveLength(count);
    expect(agentMocks.runAgent).not.toHaveBeenCalled();
  });

  it("keeps non-deadline tab setup failures on the original rejection path", async () => {
    agentMocks.onExec = () => {
      throw new Error("tab service unavailable");
    };
    await expect(
      executePromptViaBrowserAgent("get the price", "browser-1", 10, logger),
    ).rejects.toThrow("tab service unavailable");
    expect(agentMocks.execCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply a prompt deadline to replay tab selection or direct code", async () => {
    agentMocks.onExec = opts => {
      if (opts.language === "node") vi.advanceTimersByTime(6000);
    };
    await selectBrowserAgentTab("browser-1");
    const result = await executeCodeViaBrowserSession("browser-1", {
      code: "printf hello",
      language: "bash",
      timeout: 300,
    });
    expect(agentMocks.execCalls.map(call => call.timeout)).toEqual([
      10, 10, 300,
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("caps the setup probes at the remaining budget", async () => {
    agentMocks.onExec = opts => {
      // The tab-visibility probe burns 6 of the 10 allowed seconds.
      if (opts.language === "node") {
        vi.advanceTimersByTime(6000);
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
        vi.advanceTimersByTime(11000);
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
    expect(toolCallsFor("agent-browser get url")).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Prompt execution timed out after 10s.");
  });

  it("bounds tab re-selection by the remaining budget", async () => {
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      vi.advanceTimersByTime(6000);
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

  it("does not launch the second re-selection call after a late target lookup", async () => {
    let finish!: () => void;
    let lookups = 0;
    agentMocks.onExec = ({ language }) => {
      if (language === "node" && ++lookups === 2) {
        return new Promise<void>(resolve => {
          finish = resolve;
        });
      }
    };
    agentMocks.runAgent = async ({ tools }) => {
      await tools.browser.execute({ code: "agent-browser snapshot" });
      return { text: "done" };
    };
    const completed = vi.fn();
    const run = executePromptViaBrowserAgent(
      "get the price",
      "browser-1",
      1,
      logger,
    );
    void run.then(completed);
    await vi.advanceTimersByTimeAsync(1000);
    const settledAtDeadline = completed.mock.calls.length;
    finish();
    expect(await run).toMatchObject({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(settledAtDeadline).toBe(1);
    expect(
      agentMocks.execCalls.filter(c => c.code.startsWith("agent-browser tab ")),
    ).toHaveLength(1);
  });

  it.each([999, 1000])(
    "settles a pending browser tool at the deadline (browser releases at %dms)",
    async releaseAt => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      const code = "agent-browser snapshot";
      agentMocks.onExec = opts => {
        if (opts.code === code) return pending;
      };
      const settledTool = vi.fn();
      agentMocks.runAgent = async ({ tools }) => {
        const tool = tools.browser.execute({ code });
        void tool.then(settledTool, settledTool);
        await tool;
        return { text: "done" };
      };
      const run = executePromptViaBrowserAgent(
        "get the price",
        "browser-1",
        1,
        logger,
      );

      try {
        await vi.advanceTimersByTimeAsync(999);
        expect(toolCallsFor(code)).toHaveLength(1);
        expect(settledTool).not.toHaveBeenCalled();
        if (releaseAt === 999) {
          release();
          expect(await run).toMatchObject({
            exitCode: 0,
            output: "done",
            result: "updated snapshot",
          });
          expect(settledTool).toHaveBeenCalledWith({
            result: "updated snapshot",
          });
        } else {
          await vi.advanceTimersByTimeAsync(1);
          expect(settledTool).toHaveBeenCalledWith(
            expect.objectContaining({
              message: "Prompt execution timed out after 1s.",
            }),
          );
          expect(await run).toMatchObject({
            exitCode: 1,
            stderr: "Prompt execution timed out after 1s.",
            result: "initial snapshot",
          });
        }
      } finally {
        release();
        await run;
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(
        agentMocks.execCalls.filter(c => c.language === "node"),
      ).toHaveLength(releaseAt === 999 ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("skips tab re-selection if the browser command finishes at the deadline", async () => {
    agentMocks.onExec = opts => {
      // The click uses up the budget while it runs.
      if (opts.code === "agent-browser click @e1" && opts.language === "bash") {
        vi.advanceTimersByTime(2000);
      }
    };
    agentMocks.runAgent = async ({ tools }: any) => {
      const browser = tools.browser as any;
      await browser.execute({ code: "agent-browser snapshot" });
      // 8s spent: the click runs with the last 2s and finishes at the
      // deadline, so its re-selection must be skipped.
      vi.advanceTimersByTime(8000);
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
    expect(result.exitCode).toBe(1);
  });
});
