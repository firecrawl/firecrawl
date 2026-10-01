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
