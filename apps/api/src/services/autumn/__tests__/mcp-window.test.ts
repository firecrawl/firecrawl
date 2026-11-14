/**
 * The rolling window on hosted MCP credits: the counter (against a real Redis
 * when MCP_WINDOW_TEST_REDIS_URL is set, else an in-memory stand-in with the
 * same semantics), the gate's fallback to team credits, and the refusal text.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import IORedis from "ioredis";

const { state, mockCheckCredits, fake } = vi.hoisted(() => {
  const store = new Map<string, { value: number; expiresAt?: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  // Mirrors the RECORD script in mcp-window.ts.
  const fake = {
    store,
    failing: false,
    async get(key: string) {
      if (fake.failing) throw new Error("redis down");
      const entry = live(key);
      return entry ? String(entry.value) : null;
    },
    async pttl(key: string) {
      if (fake.failing) throw new Error("redis down");
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === undefined ? -1 : entry.expiresAt - Date.now();
    },
    async eval(
      _script: string,
      _keys: number,
      key: string,
      delta: number,
      ttl: number,
    ) {
      if (fake.failing) throw new Error("redis down");
      let entry = live(key);
      if (delta < 0 && !entry) return 0;
      if (!entry) {
        entry = { value: 0 };
        store.set(key, entry);
      }
      entry.value = Math.max(0, entry.value + Number(delta));
      if (entry.expiresAt === undefined)
        entry.expiresAt = Date.now() + Number(ttl);
      return entry.value;
    },
  };
  return {
    state: { hours: 5, credits: 500 },
    mockCheckCredits: vi.fn<(args: any) => Promise<any>>(),
    fake,
  };
});

const realUrl = process.env.MCP_WINDOW_TEST_REDIS_URL;
const real = realUrl ? new IORedis(realUrl) : null;

vi.mock("../../../config", () => ({
  get config() {
    return {
      MCP_CREDITS_FEATURE_ID: "MCP_CREDITS",
      MCP_WINDOW_HOURS: state.hours,
      MCP_WINDOW_CREDITS: state.credits,
    };
  },
}));

vi.mock("../../rate-limiter", () => ({
  get redisRateLimitClient() {
    return real ?? fake;
  },
}));

vi.mock("../../../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../autumn.service", () => ({
  autumnService: {
    hostedMcpFeatureId: async (_teamId: string, featureId: string) =>
      featureId === "PARTNER" ? featureId : "MCP_CREDITS",
    checkCredits: mockCheckCredits,
  },
}));

import {
  checkMcpWindow,
  formatResetCountdown,
  mcpWindowEnabled,
  recordMcpWindowUsage,
} from "../mcp-window";
import {
  checkHostedMcpCredits,
  hostedMcpCreditsRefusal,
} from "../hosted-mcp-gate";

let org = "";
let n = 0;
beforeEach(() => {
  state.hours = 5;
  state.credits = 500;
  fake.failing = false;
  fake.store.clear();
  org = `org-${process.pid}-${Date.now()}-${n++}`;
  mockCheckCredits.mockReset();
});
afterAll(async () => {
  await real?.quit();
});

const params = (value: number) => ({
  teamId: "team-1",
  orgId: org,
  value,
  featureId: "CREDITS",
});

describe(`MCP window counter (${real ? "real Redis" : "in-memory"})`, () => {
  it("is off unless both settings are positive", async () => {
    state.credits = 0;
    expect(mcpWindowEnabled()).toBe(false);
    await recordMcpWindowUsage(org, 900);
    expect(await checkMcpWindow(org, 900)).toBeNull();
    state.credits = 500;
    state.hours = 0;
    expect(mcpWindowEnabled()).toBe(false);
    expect(await checkMcpWindow(org, 900)).toBeNull();
  });

  it("admits charges up to the cap and refuses past it", async () => {
    expect(await checkMcpWindow(org, 500)).toBeNull();
    await recordMcpWindowUsage(org, 300);
    expect(await checkMcpWindow(org, 200)).toBeNull();
    const refusal = await checkMcpWindow(org, 201);
    expect(refusal).toMatchObject({ allowed: false, remaining: 200 });
  });

  it("opens the window on the first charge and reports when it closes", async () => {
    const before = Date.now();
    await recordMcpWindowUsage(org, 500);
    const refusal = await checkMcpWindow(org, 1);
    const fiveHours = 5 * 60 * 60 * 1000;
    expect(refusal?.resetsAt).toBeGreaterThan(before + fiveHours - 5000);
    expect(refusal?.resetsAt).toBeLessThanOrEqual(Date.now() + fiveHours);
  });

  it("keeps the window's close time when more is charged", async () => {
    await recordMcpWindowUsage(org, 400);
    const first = (await checkMcpWindow(org, 500))?.resetsAt ?? 0;
    await new Promise(resolve => setTimeout(resolve, 30));
    await recordMcpWindowUsage(org, 100);
    const second = (await checkMcpWindow(org, 500))?.resetsAt ?? 0;
    expect(Math.abs(second - first)).toBeLessThan(25);
  });

  it("starts a fresh window once the old one closes", async () => {
    state.hours = 0.00002; // 72 ms
    await recordMcpWindowUsage(org, 500);
    expect(await checkMcpWindow(org, 1)).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await checkMcpWindow(org, 500)).toBeNull();
  });

  it("gives refunds back, never below zero and never opening a window", async () => {
    await recordMcpWindowUsage(org, -50);
    expect(await checkMcpWindow(org, 500)).toBeNull();
    await recordMcpWindowUsage(org, 500);
    await recordMcpWindowUsage(org, -200);
    expect(await checkMcpWindow(org, 200)).toBeNull();
    await recordMcpWindowUsage(org, -900);
    expect(await checkMcpWindow(org, 500)).toBeNull();
    expect(await checkMcpWindow(org, 501)).toMatchObject({ remaining: 500 });
  });

  it("counts each org on its own", async () => {
    await recordMcpWindowUsage(org, 500);
    expect(await checkMcpWindow(`${org}-other`, 500)).toBeNull();
  });
});

describe("MCP window failure handling", () => {
  it.skipIf(!!real)("fails open when Redis can't answer", async () => {
    await recordMcpWindowUsage(org, 500);
    fake.failing = true;
    expect(await checkMcpWindow(org, 1)).toBeNull();
    await expect(recordMcpWindowUsage(org, 10)).resolves.toBeUndefined();
  });
});

describe("hosted MCP gate with the window on", () => {
  it("asks Autumn on MCP credits while the window has room", async () => {
    mockCheckCredits.mockResolvedValueOnce({ allowed: true, remaining: 900 });
    const gate = await checkHostedMcpCredits(params(10));
    expect(gate).toMatchObject({
      featureId: "MCP_CREDITS",
      onTeamCredits: false,
    });
    expect(mockCheckCredits).toHaveBeenCalledTimes(1);
    expect(mockCheckCredits.mock.calls[0][0].featureId).toBe("MCP_CREDITS");
  });

  it("falls back to team credits past the window without asking Autumn for MCP credits", async () => {
    await recordMcpWindowUsage(org, 500);
    mockCheckCredits.mockResolvedValueOnce({ allowed: true, remaining: 4000 });
    const gate = await checkHostedMcpCredits(params(10));
    expect(gate).toMatchObject({ featureId: "CREDITS", onTeamCredits: true });
    expect(mockCheckCredits).toHaveBeenCalledTimes(1);
    expect(mockCheckCredits.mock.calls[0][0].featureId).toBe("CREDITS");
  });

  it("refuses with the window's close time when the team can't pay either", async () => {
    await recordMcpWindowUsage(org, 500);
    mockCheckCredits.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const gate = await checkHostedMcpCredits(params(10));
    expect(gate.onTeamCredits).toBe(false);
    expect(gate.featureId).toBe("MCP_CREDITS");
    expect(gate.result).toMatchObject({ allowed: false, remaining: 0 });
    expect(gate.result?.resetsAt).toBeGreaterThan(Date.now());
    expect(gate.teamRefusal).toMatchObject({ allowed: false });
  });

  it("leaves the MCP refusal standing when the team check can't answer", async () => {
    await recordMcpWindowUsage(org, 500);
    mockCheckCredits.mockResolvedValueOnce(null);
    const gate = await checkHostedMcpCredits(params(10));
    expect(gate).toMatchObject({
      featureId: "MCP_CREDITS",
      onTeamCredits: false,
    });
    expect(gate.result?.allowed).toBe(false);
  });

  it("skips the window for a partner-provisioned team", async () => {
    await recordMcpWindowUsage(org, 500);
    mockCheckCredits.mockResolvedValueOnce({ allowed: true, remaining: 10 });
    const gate = await checkHostedMcpCredits({
      ...params(10),
      featureId: "PARTNER",
    });
    expect(gate).toMatchObject({ featureId: "PARTNER", onTeamCredits: false });
  });

  it("behaves as before with the window off", async () => {
    state.credits = 0;
    await recordMcpWindowUsage(org, 9000);
    mockCheckCredits.mockResolvedValueOnce({ allowed: true, remaining: 100 });
    const gate = await checkHostedMcpCredits(params(10));
    expect(gate).toMatchObject({
      featureId: "MCP_CREDITS",
      onTeamCredits: false,
    });
    expect(mockCheckCredits.mock.calls[0][0].featureId).toBe("MCP_CREDITS");
  });
});

describe("refusal text", () => {
  it("formats the countdown", () => {
    const now = 1_800_000_000_000;
    expect(formatResetCountdown(now + (2 * 60 + 14) * 60000 + 30000, now)).toBe(
      "2h 14m",
    );
    expect(formatResetCountdown(now + 3 * 60 * 60000, now)).toBe("3h");
    expect(formatResetCountdown(now + 14 * 60000, now)).toBe("14m");
    expect(formatResetCountdown(now + 20000, now)).toBe("under a minute");
    expect(formatResetCountdown(now - 5000, now)).toBe("under a minute");
  });

  it("shows the countdown and drops 'daily' with the window on", () => {
    const text = hostedMcpCreditsRefusal(
      Date.now() + (2 * 60 + 14) * 60000 + 30000,
    );
    expect(text).toContain("the allowance resets in 2h 14m (at ");
    expect(text).not.toContain("daily");
    expect(hostedMcpCreditsRefusal()).not.toContain("resets");
  });

  it("keeps today's wording with the window off", () => {
    state.credits = 0;
    const at = Date.UTC(2026, 10, 11, 2, 52);
    expect(hostedMcpCreditsRefusal(at)).toBe(
      "Insufficient credits for this connected-app request. Hosted MCP calls (from apps such as ChatGPT, Claude or Codex) spend a daily MCP credit allowance first and then your team's credits, and neither can cover this request; the allowance resets at 2026-11-11T02:52:00.000Z. To continue now, add credits or upgrade your plan at https://firecrawl.dev/pricing.",
    );
  });
});
