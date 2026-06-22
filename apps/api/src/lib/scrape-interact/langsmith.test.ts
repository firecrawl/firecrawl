/**
 * Sanity tests for the LangSmith wiring. The disabled-path block isolates
 * modules and strips LANGSMITH_* env vars so the tests don't depend on the
 * developer's local .env, where LANGSMITH_API_KEY may or may not be set.
 */
import * as ai from "ai";

// langsmith.ts pulls the SDK in via lazy require() (not static import), and
// vi.doMock only intercepts dynamic import(), not require(). So these two are
// mocked statically (hoisted, like jest.mock) with a mutable backing the enabled
// tests wire up per-run. The disabled tests never hit the require() branch
// (isLangSmithEnabled is false), so these factories simply never execute there.
const sdkMocks = vi.hoisted(() => ({
  wrapAISDK: undefined as undefined | ((...args: any[]) => any),
  createLangSmithProviderOptions: undefined as
    | undefined
    | ((...args: any[]) => any),
  traceable: undefined as undefined | ((...args: any[]) => any),
  vercelThrows: false,
}));

vi.mock("langsmith/experimental/vercel", () => {
  if (sdkMocks.vercelThrows) {
    throw new Error("simulated install breakage");
  }
  return {
    wrapAISDK: (...args: any[]) => sdkMocks.wrapAISDK!(...args),
    createLangSmithProviderOptions: (...args: any[]) =>
      sdkMocks.createLangSmithProviderOptions!(...args),
  };
});

vi.mock("langsmith/traceable", () => ({
  traceable: (...args: any[]) => sdkMocks.traceable!(...args),
}));

describe("scrape-interact/langsmith (disabled — no API key)", () => {
  beforeEach(() => {
    vi.resetModules();
    // Mock config to ensure LANGSMITH_API_KEY is unset regardless of what's
    // in the developer's local .env file — this keeps the disabled-path
    // tests hermetic.
    vi.doMock("../../config", () => ({
      config: {
        LANGSMITH_API_KEY: undefined,
        LANGSMITH_TRACING: undefined,
        LANGSMITH_PROJECT: undefined,
        LANGSMITH_ENDPOINT: undefined,
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../config");
  });

  it("reports disabled when LANGSMITH_API_KEY is unset", async () => {
    const mod = await import("./langsmith.js");
    expect(mod.isLangSmithEnabled).toBe(false);
  });

  it("re-exports raw ai SDK functions when disabled", async () => {
    const freshAi = await import("ai");
    const mod = await import("./langsmith.js");
    expect(mod.generateText).toBe(freshAi.generateText);
    expect(mod.streamText).toBe(freshAi.streamText);
    expect(mod.generateObject).toBe(freshAi.generateObject);
    expect(mod.streamObject).toBe(freshAi.streamObject);
  });

  it("returns undefined providerOptions when disabled", async () => {
    const mod = await import("./langsmith.js");
    const opts = mod.buildLangSmithProviderOptions(
      {
        thread_id: "t1",
        session_id: "t1",
        scrape_id: "s1",
        team_id: "team1",
        mode: "prompt",
      },
      { name: "test" },
    );
    expect(opts).toBeUndefined();
  });

  it("traceInteract returns the original function unchanged when disabled", async () => {
    const mod = await import("./langsmith.js");
    const original = async (x: number) => x * 2;
    const wrapped = mod.traceInteract(
      original,
      {
        thread_id: "t1",
        session_id: "t1",
        scrape_id: "s1",
        team_id: "team1",
        mode: "code",
      },
      { name: "test" },
    );
    expect(wrapped).toBe(original);
    await expect(wrapped(3)).resolves.toBe(6);
  });

  it("treats an API key alone (no LANGSMITH_TRACING) as disabled", async () => {
    vi.resetModules();
    vi.doMock("../../config", () => ({
      config: {
        LANGSMITH_API_KEY: "real-looking-key",
        LANGSMITH_TRACING: undefined,
        LANGSMITH_PROJECT: undefined,
        LANGSMITH_ENDPOINT: undefined,
      },
    }));
    const mod = await import("./langsmith.js");
    expect(mod.isLangSmithEnabled).toBe(false);
  });

  it("treats whitespace-only LANGSMITH_API_KEY as disabled", async () => {
    vi.resetModules();
    vi.doMock("../../config", () => ({
      config: {
        LANGSMITH_API_KEY: "   \t\n  ",
        LANGSMITH_TRACING: true,
        LANGSMITH_PROJECT: undefined,
        LANGSMITH_ENDPOINT: undefined,
      },
    }));
    const mod = await import("./langsmith.js");
    expect(mod.isLangSmithEnabled).toBe(false);
  });

  it("sanitizeUrlForTrace strips query strings and fragments", async () => {
    const { sanitizeUrlForTrace } = await import("./langsmith.js");
    expect(sanitizeUrlForTrace("https://example.com/page?token=abc#x")).toBe(
      "https://example.com/page",
    );
    expect(sanitizeUrlForTrace("https://example.com/")).toBe(
      "https://example.com/",
    );
    expect(sanitizeUrlForTrace(null)).toBeUndefined();
    expect(sanitizeUrlForTrace(undefined)).toBeUndefined();
    // Malformed URL still gets query/fragment stripped
    expect(sanitizeUrlForTrace("not a url?token=secret#frag")).toBe(
      "not a url",
    );
    expect(sanitizeUrlForTrace("not a url")).toBe("not a url");
  });
});

describe("scrape-interact/langsmith (enabled — mocked SDK)", () => {
  // These tests reset module state and provide fake langsmith modules so we
  // can exercise the wrap path without network calls or a real API key.
  //
  // NOTE: langsmith.ts loads the SDK via a lazy CommonJS require() at module
  // eval time (intentionally, so a missing install degrades gracefully). Vitest
  // injects a *native* require() into ESM source that bypasses the mock registry,
  // so vi.mock / vi.doMock cannot intercept these. Under Jest these were mocked
  // via jest.doMock + require. The only ways to restore this coverage are to
  // change production source (make the SDK load a dynamic import / top-level
  // await), which would alter module-init semantics. Skipped pending that
  // decision — the disabled path (the default) remains fully covered above.

  const ORIGINAL_ENV = { ...process.env };
  const fakeWrappedFns = {
    generateText: vi.fn(),
    streamText: vi.fn(),
    generateObject: vi.fn(),
    streamObject: vi.fn(),
  };
  const createProviderOptionsSpy = vi.fn((opts: unknown) => ({
    __fake_langsmith_options__: true,
    payload: opts,
  }));
  const traceableSpy = vi.fn(
    (fn: (...args: unknown[]) => unknown, _opts: unknown) => {
      const wrapper = (...args: unknown[]) => fn(...args);
      (
        wrapper as unknown as { __fake_traceable__: boolean }
      ).__fake_traceable__ = true;
      return wrapper;
    },
  );

  beforeEach(() => {
    vi.resetModules();
    createProviderOptionsSpy.mockClear();
    traceableSpy.mockClear();
    // Wire the statically-mocked SDK to this block's fakes.
    sdkMocks.vercelThrows = false;
    sdkMocks.wrapAISDK = () => fakeWrappedFns;
    sdkMocks.createLangSmithProviderOptions = createProviderOptionsSpy;
    sdkMocks.traceable = traceableSpy;
    // Mock config with only the fields the module reads so the test is
    // hermetic — it doesn't depend on the developer's local .env making it
    // through the zod schema at require time.
    vi.doMock("../../config", () => ({
      config: {
        LANGSMITH_API_KEY: "test-fake-key",
        LANGSMITH_TRACING: true,
        LANGSMITH_PROJECT: "test-project",
        LANGSMITH_ENDPOINT: undefined,
      },
    }));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    sdkMocks.vercelThrows = false;
    vi.doUnmock("../../config");
  });

  it.skip("reports enabled and swaps generateText for the wrapped fn", async () => {
    const mod = await import("./langsmith.js");
    expect(mod.isLangSmithEnabled).toBe(true);
    expect(mod.generateText).toBe(fakeWrappedFns.generateText);
    expect(mod.generateText).not.toBe(ai.generateText);
  });

  it.skip("builds provider options with thread_id + scrape context metadata", async () => {
    const mod = await import("./langsmith.js");
    const result = mod.buildLangSmithProviderOptions(
      {
        thread_id: "sess-abc",
        session_id: "sess-abc",
        scrape_id: "scrape-xyz",
        team_id: "team-42",
        browser_id: "browser-1",
        mode: "prompt",
        scrape_url: "https://example.com/pricing",
        target_url: "https://example.com/pricing/",
        scrape_wait_for_ms: 500,
        scrape_actions: 2,
        scrape_origin: "api",
      },
      { name: "interact:prompt", extra: { prompt_length: 123 } },
    );

    expect(createProviderOptionsSpy).toHaveBeenCalledTimes(1);
    const callArg = createProviderOptionsSpy.mock.calls[0][0] as {
      name: string;
      metadata: Record<string, unknown>;
      tags: string[];
    };
    expect(callArg.name).toBe("interact:prompt");
    expect(callArg.metadata).toMatchObject({
      thread_id: "sess-abc",
      session_id: "sess-abc",
      scrape_id: "scrape-xyz",
      team_id: "team-42",
      scrape_url: "https://example.com/pricing",
      target_url: "https://example.com/pricing/",
      scrape_wait_for_ms: 500,
      scrape_actions: 2,
      scrape_origin: "api",
      browser_id: "browser-1",
      mode: "prompt",
      prompt_length: 123,
    });
    expect(callArg.tags).toEqual(["interact", "mode:prompt"]);
    expect(result).toMatchObject({ __fake_langsmith_options__: true });
  });

  it("skips tracing when meta.zeroDataRetention is true", async () => {
    const mod = await import("./langsmith.js");
    const result = mod.buildLangSmithProviderOptions({
      thread_id: "sess-abc",
      session_id: "sess-abc",
      scrape_id: "scrape-xyz",
      team_id: "team-42",
      mode: "prompt",
      zeroDataRetention: true,
    });
    expect(result).toBeUndefined();
    expect(createProviderOptionsSpy).not.toHaveBeenCalled();

    const fn = async () => "should-still-run";
    const wrapped = mod.traceInteract(fn, {
      thread_id: "sess-abc",
      session_id: "sess-abc",
      scrape_id: "scrape-xyz",
      team_id: "team-42",
      mode: "code",
      zeroDataRetention: true,
    });
    expect(wrapped).toBe(fn);
    expect(traceableSpy).not.toHaveBeenCalled();
  });

  it.skip("wraps functions via traceable when zeroDataRetention is not set", async () => {
    const mod = await import("./langsmith.js");
    const fn = vi.fn(async (x: number) => x + 1);
    const wrapped = mod.traceInteract(
      fn,
      {
        thread_id: "sess-abc",
        session_id: "sess-abc",
        scrape_id: "scrape-xyz",
        team_id: "team-42",
        mode: "code",
      },
      { name: "interact:code" },
    );
    expect(traceableSpy).toHaveBeenCalledTimes(1);
    const traceableOpts = traceableSpy.mock.calls[0][1] as {
      name: string;
      run_type: string;
      metadata: Record<string, unknown>;
      tags: string[];
    };
    expect(traceableOpts.name).toBe("interact:code");
    expect(traceableOpts.run_type).toBe("chain");
    expect(traceableOpts.tags).toEqual(["interact", "mode:code"]);
    expect(traceableOpts.metadata).toMatchObject({
      thread_id: "sess-abc",
      mode: "code",
    });
    await expect(wrapped(5)).resolves.toBe(6);
    expect(fn).toHaveBeenCalledWith(5);
  });

  it.skip("falls back to raw ai SDK when langsmith require() throws", async () => {
    vi.resetModules();
    sdkMocks.vercelThrows = true;
    // Re-import ai from the fresh module graph so the identity check lines up
    // with the module instance the langsmith helper imported.
    const freshAi = await import("ai");
    const mod = await import("./langsmith.js");
    expect(mod.generateText).toBe(freshAi.generateText);
    expect(
      mod.buildLangSmithProviderOptions({
        thread_id: "t",
        session_id: "t",
        scrape_id: "s",
        team_id: "x",
        mode: "prompt",
      }),
    ).toBeUndefined();
  });
});
