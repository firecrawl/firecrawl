import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh module, so it reads the stubbed POSTHOG_API_KEY at import. */
async function load(apiKey: string) {
  vi.resetModules();
  vi.stubEnv("POSTHOG_API_KEY", apiKey);
  vi.stubEnv("POSTHOG_HOST", "https://ph.example.com/");
  return await import("./posthog-capture.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("capturePostHog", () => {
  it("resolves true when PostHog accepts the event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { capturePostHog } = await load("phc_test");

    await expect(capturePostHog("e", "d", { a: 1 })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ph.example.com/capture/",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "phc_test",
          event: "e",
          distinct_id: "d",
          properties: { a: 1 },
        }),
      }),
    );
  });

  it.each([400, 401, 500, 503])(
    "resolves false on a %i answer",
    async status => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("no", { status })),
      );
      const { capturePostHog } = await load("phc_test");

      await expect(capturePostHog("e", "d")).resolves.toBe(false);
    },
  );

  it("resolves false, without rejecting, on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("reset")));
    const { capturePostHog } = await load("phc_test");

    await expect(capturePostHog("e", "d")).resolves.toBe(false);
  });

  it("sends nothing and resolves false with no key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { capturePostHog, isPostHogCaptureEnabled } = await load("");

    expect(isPostHogCaptureEnabled()).toBe(false);
    await expect(capturePostHog("e", "d")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("evaluatePostHogFlag", () => {
  const flagsResponse = (body: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));

  it("returns the variant and asks for that flag with the groups", async () => {
    const fetchMock = flagsResponse({
      flags: { "my-flag": { enabled: true, variant: "treatment" } },
      errorsWhileComputingFlags: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    const { evaluatePostHogFlag } = await load("phc_test");

    await expect(
      evaluatePostHogFlag("my-flag", "d", { company: "org-1" }),
    ).resolves.toEqual({ status: "resolved", variant: "treatment" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ph.example.com/flags/?v=2",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "phc_test",
          distinct_id: "d",
          groups: { company: "org-1" },
          flag_keys_to_evaluate: ["my-flag"],
        }),
      }),
    );
  });

  it.each([401, 404])(
    "is disabled when PostHog rejects the request with %i",
    async status => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("no", { status })),
      );
      const { evaluatePostHogFlag } = await load("phc_test");

      await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
        status: "disabled",
      });
    },
  );

  it.each([
    ["an unknown flag", { flags: {} }],
    ["a flag that is off", { flags: { "my-flag": { enabled: false } } }],
    [
      "a boolean flag",
      { flags: { "my-flag": { enabled: true, variant: null } } },
    ],
  ])("is disabled for %s", async (_label, body) => {
    vi.stubGlobal("fetch", flagsResponse(body));
    const { evaluatePostHogFlag } = await load("phc_test");

    await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
      status: "disabled",
    });
  });

  it.each([
    ["a 503 answer", () => new Response("no", { status: 503 })],
    ["a 429 answer", () => new Response("no", { status: 429 })],
    [
      "errors while computing flags",
      () =>
        new Response(
          JSON.stringify({ flags: {}, errorsWhileComputingFlags: true }),
        ),
    ],
    [
      "a quota limit",
      () =>
        new Response(
          JSON.stringify({ flags: {}, quotaLimited: ["feature_flags"] }),
        ),
    ],
  ])("is retryable on %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const { evaluatePostHogFlag } = await load("phc_test");

    await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
      status: "retryable",
    });
  });

  it("is retryable, without rejecting, on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed")));
    const { evaluatePostHogFlag } = await load("phc_test");

    await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
      status: "retryable",
    });
  });

  it("gives up after 500 ms and is retryable", async () => {
    // Answers only when the request is aborted, like a PostHog that hangs.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(init.signal!.reason),
            ),
          ),
      ),
    );
    const { evaluatePostHogFlag } = await load("phc_test");

    const start = Date.now();
    await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
      status: "retryable",
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(450);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("asks nothing and is disabled with no key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { evaluatePostHogFlag } = await load("");

    await expect(evaluatePostHogFlag("my-flag", "d")).resolves.toEqual({
      status: "disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
