import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------

const mockGetValue = vi.fn<(key: string) => Promise<string | null>>();
const mockSetValue =
  vi.fn<(key: string, value: string, ttl: number) => Promise<void>>();
vi.mock("../../../services/redis", () => ({
  getValue: (key: string) => mockGetValue(key),
  setValue: (key: string, value: string, ttl: number) =>
    mockSetValue(key, value, ttl),
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
  browserCreditsPerHour,
  BROWSER_CREDITS_PER_HOUR,
  BROWSER_ZDR_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
} from "../../../lib/browser-billing";

import {
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
} from "../../../lib/browser-sessions";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetValue.mockResolvedValue(null);
  mockSetValue.mockResolvedValue(undefined);
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

  it("ZDR surcharge is 120 credits/hour (2 credits/min)", () => {
    expect(BROWSER_ZDR_CREDITS_PER_HOUR).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// browserCreditsPerHour
// ---------------------------------------------------------------------------

describe("browserCreditsPerHour", () => {
  it("uses the base rates without ZDR", () => {
    expect(browserCreditsPerHour(false, false)).toBe(120);
    expect(browserCreditsPerHour(true, false)).toBe(420);
  });

  it("adds 2 credits/min to both rates with ZDR", () => {
    expect(browserCreditsPerHour(false, true)).toBe(240);
    expect(browserCreditsPerHour(true, true)).toBe(540);
  });

  it("bills ZDR code-only sessions at 4 credits/min (minimum 4)", () => {
    const rate = browserCreditsPerHour(false, true);
    expect(calculateBrowserSessionCredits(0, rate)).toBe(4);
    expect(calculateBrowserSessionCredits(60_000, rate)).toBe(4);
    expect(calculateBrowserSessionCredits(5 * 60_000, rate)).toBe(20);
    expect(calculateBrowserSessionCredits(3_600_000, rate)).toBe(240);
  });

  it("bills ZDR prompt sessions at 9 credits/min (minimum 9)", () => {
    const rate = browserCreditsPerHour(true, true);
    expect(calculateBrowserSessionCredits(0, rate)).toBe(9);
    expect(calculateBrowserSessionCredits(60_000, rate)).toBe(9);
    expect(calculateBrowserSessionCredits(5 * 60_000, rate)).toBe(45);
    expect(calculateBrowserSessionCredits(3_600_000, rate)).toBe(540);
    // 91s / 3600s * 540 = 13.65 → ceil = 14
    expect(calculateBrowserSessionCredits(91_000, rate)).toBe(14);
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
    it("returns minimum 7 credits (one minute) for very short sessions", () => {
      expect(calculateBrowserSessionCredits(0, INTERACT_CREDITS_PER_HOUR)).toBe(
        7,
      );
      expect(
        calculateBrowserSessionCredits(1000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(7);
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
      // 91s / 3600s * 420 = 10.616... → ceil = 11
      expect(
        calculateBrowserSessionCredits(91_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(11);
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
    it("sets Redis flag with a 2-day TTL", async () => {
      await markBrowserSessionUsedPrompt("session-123");

      expect(mockSetValue).toHaveBeenCalledWith(
        "browser_session:used_prompt:session-123",
        "1",
        2 * 86400,
      );
    });

    it("propagates Redis failure so the prompt is not admitted", async () => {
      mockSetValue.mockRejectedValueOnce(new Error("Redis down"));

      await expect(markBrowserSessionUsedPrompt("session-123")).rejects.toThrow(
        "Redis down",
      );
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

    it("propagates Redis failure so settlement retries instead of billing the cheaper rate", async () => {
      mockGetValue.mockRejectedValueOnce(new Error("Redis down"));

      await expect(didBrowserSessionUsePrompt("session-123")).rejects.toThrow(
        "Redis down",
      );
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

  it("full flow: mark → check → bill", async () => {
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
  });
});
