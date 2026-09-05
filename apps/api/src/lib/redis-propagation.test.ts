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

describe("Redis error propagation", () => {
  const error = new Error("original Redis command failure");
  beforeEach(() => {
    fail.mockRejectedValue(error);
  });

  it("rejects billing reads, writes and cleanup with the original error", async () => {
    await expect(markBrowserSessionUsedPrompt("test")).rejects.toBe(error);
    await expect(didBrowserSessionUsePrompt("test")).rejects.toBe(error);
    await expect(clearBrowserSessionPromptFlag("test")).rejects.toBe(error);
    await expect(invalidateActiveBrowserSessionCount("test")).rejects.toBe(
      error,
    );
  });

  it("rejects a failed activity enqueue", async () => {
    await expect(
      enqueueBrowserSessionActivity({
        team_id: "test",
        session_id: "test",
        source: "browser",
        language: "javascript",
        timeout: 1,
        exit_code: null,
        killed: false,
      }),
    ).rejects.toBe(error);
  });
});
