import { agentJobExpiry } from "./agent-job-expiry";

const MINUTE = 60 * 1000;
const STARTED_AT = Date.parse("2026-10-28T20:00:00.000Z");
const COMPLETED_AT = "2026-10-28T20:20:19.000Z";
const COMPLETED_AT_MS = Date.parse(COMPLETED_AT);
const ROW_EXPIRES_AT_MS = STARTED_AT + 24 * 60 * MINUTE;

describe("agentJobExpiry", () => {
  it("counts a 15 minute retention from completion", () => {
    expect(
      agentJobExpiry(
        { expiresAtMs: ROW_EXPIRES_AT_MS, zeroDataRetentionMinutes: 15 },
        { status: "success", completedAt: COMPLETED_AT },
        COMPLETED_AT_MS + MINUTE,
      ),
    ).toEqual({
      expiresAtMs: COMPLETED_AT_MS + 15 * MINUTE,
      zeroDataRetentionExpired: false,
    });
  });

  it("reports a finished run past its retention as expired", () => {
    expect(
      agentJobExpiry(
        { expiresAtMs: ROW_EXPIRES_AT_MS, zeroDataRetentionMinutes: 15 },
        { status: "success", completedAt: COMPLETED_AT },
        COMPLETED_AT_MS + 15 * MINUTE,
      ).zeroDataRetentionExpired,
    ).toBe(true);
  });

  it("caps the default 24 hour retention at the access row", () => {
    expect(
      agentJobExpiry(
        { expiresAtMs: ROW_EXPIRES_AT_MS, zeroDataRetentionMinutes: 24 * 60 },
        { status: "success", completedAt: COMPLETED_AT },
        COMPLETED_AT_MS + MINUTE,
      ),
    ).toEqual({
      expiresAtMs: ROW_EXPIRES_AT_MS,
      zeroDataRetentionExpired: false,
    });
  });

  it("reports the earliest deadline while a ZDR run is still running", () => {
    const now = STARTED_AT + 5 * MINUTE;
    expect(
      agentJobExpiry(
        { expiresAtMs: ROW_EXPIRES_AT_MS, zeroDataRetentionMinutes: 15 },
        { status: "processing" },
        now,
      ),
    ).toEqual({
      expiresAtMs: now + 15 * MINUTE,
      zeroDataRetentionExpired: false,
    });
  });

  it("counts from the start for a finished run with no completion time", () => {
    const later = STARTED_AT + 60 * MINUTE;
    for (const completedAt of [undefined, "not a date"]) {
      expect(
        agentJobExpiry(
          { expiresAtMs: ROW_EXPIRES_AT_MS, zeroDataRetentionMinutes: 15 },
          { status: "failed", completedAt },
          later,
        ),
      ).toEqual({
        expiresAtMs: STARTED_AT + 15 * MINUTE,
        zeroDataRetentionExpired: false,
      });
    }
  });

  it("keeps the row's expiry for a legacy row with no retention", () => {
    expect(
      agentJobExpiry(
        { expiresAtMs: ROW_EXPIRES_AT_MS },
        { status: "success", completedAt: COMPLETED_AT },
        ROW_EXPIRES_AT_MS - MINUTE,
      ),
    ).toEqual({
      expiresAtMs: ROW_EXPIRES_AT_MS,
      zeroDataRetentionExpired: false,
    });
  });
});
