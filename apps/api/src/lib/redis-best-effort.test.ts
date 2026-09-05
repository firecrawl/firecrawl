const { fail, warn } = vi.hoisted(() => ({ fail: vi.fn(), warn: vi.fn() }));
vi.mock("../services/redis", () => ({
  getValue: fail,
  setValue: fail,
  deleteKey: fail,
  redisEvictConnection: { rpush: fail },
}));
vi.mock("../db/connection", () => ({ db: {} }));
vi.mock("../db/schema", () => ({}));
vi.mock("./logger", () => ({ logger: { child: () => ({ warn }) } }));

import {
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
  invalidateActiveBrowserSessionCount,
} from "./browser-sessions";
import { enqueueBrowserSessionActivity } from "./browser-session-activity";

describe("best-effort Redis diagnostics", () => {
  beforeEach(() => {
    warn.mockClear();
    fail.mockRejectedValue(
      Object.assign(new Error("OOM private-value"), {
        command: { args: ["secret"] },
      }),
    );
  });

  it("keeps the billing fallback while reporting read, write and cleanup failures", async () => {
    await markBrowserSessionUsedPrompt("test");
    expect(await didBrowserSessionUsePrompt("test")).toBe(false);
    await clearBrowserSessionPromptFlag("test");
    await invalidateActiveBrowserSessionCount("test");
    expect(warn).toHaveBeenCalledTimes(4);
    for (const [, details] of warn.mock.calls)
      expect(details).toEqual({ redisError: "OOM" });
  });

  it("reports a failed activity enqueue without rejecting the caller", async () => {
    enqueueBrowserSessionActivity({
      team_id: "test",
      session_id: "test",
      source: "browser",
      language: "javascript",
      timeout: 1,
      exit_code: null,
      killed: false,
    });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      "Failed to enqueue browser session activity",
      { redisError: "OOM" },
    );
  });
});
