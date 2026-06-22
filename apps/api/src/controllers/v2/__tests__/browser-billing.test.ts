import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------

const mockGetValue = vi.fn<(key: string) => Promise<string | null>>();
const mockSetValue =
  vi.fn<(key: string, value: string, ttl: number) => Promise<void>>();
const mockDeleteKey = vi.fn<(key: string) => Promise<void>>();

vi.mock("../../../services/redis", () => ({
  getValue: (key: string) => mockGetValue(key),
  setValue: (key: string, value: string, ttl: number) =>
    mockSetValue(key, value, ttl),
  deleteKey: (key: string) => mockDeleteKey(key),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import {
  calculateBrowserSessionCredits,
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
} from "../../../lib/browser-billing";

import {
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../../lib/browser-sessions";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetValue.mockResolvedValue(null);
  mockSetValue.mockResolvedValue(undefined);
  mockDeleteKey.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("billing constants", () => {
  it("browser rate is 120 credits/hour", () => {
    expect(BROWSER_CREDITS_PER_HOUR).toBe(120);
  });

  it("interact rate is 420 credits/hour (7 credits/min)", () => {
    expect(INTERACT_CREDITS_PER_HOUR).toBe(420);
  });
});

// ---------------------------------------------------------------------------
// calculateBrowserSessionCredits
// ---------------------------------------------------------------------------

describe("calculateBrowserSessionCredits", () => {
  describe("with default browser rate (120/hr)", () => {
    it("returns minimum 2 credits for very short sessions", () => {
      expect(calculateBrowserSessionCredits(0)).toBe(2);
      expect(calculateBrowserSessionCredits(1000)).toBe(2);
      expect(calculateBrowserSessionCredits(10_000)).toBe(2);
    });

    it("calculates correctly for 1 minute", () => {
      expect(calculateBrowserSessionCredits(60_000)).toBe(2);
    });

    it("calculates correctly for 5 minutes", () => {
      expect(calculateBrowserSessionCredits(5 * 60_000)).toBe(10);
    });

    it("calculates correctly for 10 minutes", () => {
      expect(calculateBrowserSessionCredits(10 * 60_000)).toBe(20);
    });

    it("calculates correctly for 1 hour", () => {
      expect(calculateBrowserSessionCredits(3_600_000)).toBe(120);
    });

    it("rounds up to next integer", () => {
      // 61s / 3600s * 120 = 2.033... → ceil = 3
      expect(calculateBrowserSessionCredits(61_000)).toBe(3);
    });
  });

  describe("with interact rate (420/hr)", () => {
    it("returns minimum 2 credits for very short sessions", () => {
      expect(calculateBrowserSessionCredits(0, INTERACT_CREDITS_PER_HOUR)).toBe(
        2,
      );
      expect(
        calculateBrowserSessionCredits(1000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(2);
    });

    it("calculates 7 credits per minute", () => {
      expect(
        calculateBrowserSessionCredits(60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(7);
    });

    it("calculates 35 credits for 5 minutes", () => {
      expect(
        calculateBrowserSessionCredits(5 * 60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(35);
    });

    it("calculates 70 credits for 10 minutes", () => {
      expect(
        calculateBrowserSessionCredits(10 * 60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(70);
    });

    it("calculates 420 credits for 1 hour", () => {
      expect(
        calculateBrowserSessionCredits(3_600_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(420);
    });

    it("rounds up to next integer", () => {
      // 31s / 3600s * 420 = 3.616... → ceil = 4
      expect(
        calculateBrowserSessionCredits(31_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(4);
    });
  });

  describe("rate comparison", () => {
    it("interact rate is always >= browser rate for same duration", () => {
      const durations = [0, 1000, 30_000, 60_000, 300_000, 600_000, 3_600_000];
      for (const ms of durations) {
        const browserCredits = calculateBrowserSessionCredits(
          ms,
          BROWSER_CREDITS_PER_HOUR,
        );
        const interactCredits = calculateBrowserSessionCredits(
          ms,
          INTERACT_CREDITS_PER_HOUR,
        );
        expect(interactCredits).toBeGreaterThanOrEqual(browserCredits);
      }
    });

    it("interact rate is 3.5x browser rate for non-trivial durations", () => {
      const browser = calculateBrowserSessionCredits(
        5 * 60_000,
        BROWSER_CREDITS_PER_HOUR,
      );
      const interact = calculateBrowserSessionCredits(
        5 * 60_000,
        INTERACT_CREDITS_PER_HOUR,
      );
      expect(interact / browser).toBe(3.5);
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt flag Redis helpers
// ---------------------------------------------------------------------------

describe("prompt usage tracking", () => {
  describe("markBrowserSessionUsedPrompt", () => {
    it("sets Redis flag with 2-hour TTL", async () => {
      await markBrowserSessionUsedPrompt("session-123");

      expect(mockSetValue).toHaveBeenCalledWith(
        "browser_session:used_prompt:session-123",
        "1",
        7200,
      );
    });

    it("does not throw on Redis failure", async () => {
      mockSetValue.mockRejectedValueOnce(new Error("Redis down"));

      await expect(
        markBrowserSessionUsedPrompt("session-123"),
      ).resolves.not.toThrow();
    });
  });

  describe("didBrowserSessionUsePrompt", () => {
    it("returns true when flag is set", async () => {
      mockGetValue.mockResolvedValueOnce("1");

      const result = await didBrowserSessionUsePrompt("session-123");
      expect(result).toBe(true);
      expect(mockGetValue).toHaveBeenCalledWith(
        "browser_session:used_prompt:session-123",
      );
    });

    it("returns false when flag is not set", async () => {
      mockGetValue.mockResolvedValueOnce(null);

      const result = await didBrowserSessionUsePrompt("session-123");
      expect(result).toBe(false);
    });

    it("returns false on Redis failure (graceful fallback to browser rate)", async () => {
      mockGetValue.mockRejectedValueOnce(new Error("Redis down"));

      const result = await didBrowserSessionUsePrompt("session-123");
      expect(result).toBe(false);
    });
  });

  describe("clearBrowserSessionPromptFlag", () => {
    it("deletes the Redis key", async () => {
      await clearBrowserSessionPromptFlag("session-123");

      expect(mockDeleteKey).toHaveBeenCalledWith(
        "browser_session:used_prompt:session-123",
      );
    });

    it("does not throw on Redis failure", async () => {
      mockDeleteKey.mockRejectedValueOnce(new Error("Redis down"));

      await expect(
        clearBrowserSessionPromptFlag("session-123"),
      ).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Billing rate selection (integration of flag + rate)
// ---------------------------------------------------------------------------

describe("billing rate selection", () => {
  it("uses 420/hr when prompt flag is set", async () => {
    mockGetValue.mockResolvedValueOnce("1");

    const usedPrompt = await didBrowserSessionUsePrompt("session-123");
    const rate = usedPrompt
      ? INTERACT_CREDITS_PER_HOUR
      : BROWSER_CREDITS_PER_HOUR;
    const credits = calculateBrowserSessionCredits(5 * 60_000, rate);

    expect(usedPrompt).toBe(true);
    expect(rate).toBe(420);
    expect(credits).toBe(35);
  });

  it("uses 120/hr when no prompt was used", async () => {
    mockGetValue.mockResolvedValueOnce(null);

    const usedPrompt = await didBrowserSessionUsePrompt("session-123");
    const rate = usedPrompt
      ? INTERACT_CREDITS_PER_HOUR
      : BROWSER_CREDITS_PER_HOUR;
    const credits = calculateBrowserSessionCredits(5 * 60_000, rate);

    expect(usedPrompt).toBe(false);
    expect(rate).toBe(120);
    expect(credits).toBe(10);
  });

  it("falls back to 120/hr when Redis is down", async () => {
    mockGetValue.mockRejectedValueOnce(new Error("Redis down"));

    const usedPrompt = await didBrowserSessionUsePrompt("session-123");
    const rate = usedPrompt
      ? INTERACT_CREDITS_PER_HOUR
      : BROWSER_CREDITS_PER_HOUR;
    const credits = calculateBrowserSessionCredits(5 * 60_000, rate);

    expect(usedPrompt).toBe(false);
    expect(rate).toBe(120);
    expect(credits).toBe(10);
  });

  it("full flow: mark → check → bill → clear", async () => {
    await markBrowserSessionUsedPrompt("session-456");
    expect(mockSetValue).toHaveBeenCalledTimes(1);

    mockGetValue.mockResolvedValueOnce("1");
    const usedPrompt = await didBrowserSessionUsePrompt("session-456");
    expect(usedPrompt).toBe(true);

    const credits = calculateBrowserSessionCredits(
      3 * 60_000,
      INTERACT_CREDITS_PER_HOUR,
    );
    expect(credits).toBe(21); // 3 min * 7 credits/min

    await clearBrowserSessionPromptFlag("session-456");
    expect(mockDeleteKey).toHaveBeenCalledTimes(1);
  });
});
