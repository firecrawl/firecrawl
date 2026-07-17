import { config } from "../../../../../config";
import {
  decideFirePdfAsyncRoute,
  deterministicPercentage,
  FIRE_PDF_ASYNC_MIN_REMAINING_MS,
} from "../fire-pdf/routing";
import {
  computeDeadlineMs,
  firePdfHeaders,
  nextPollDelay,
} from "../fire-pdf/utils";

const baseInput = {
  scrapeId: "scrape-1",
  teamId: "team-1",
  zeroDataRetention: false,
  remainingMs: 60_000,
  requestOptIn: false,
  percentage: 0,
  allowRequestOverride: false,
};

describe("FirePDF async routing", () => {
  it("is traffic-neutral by default", () => {
    expect(decideFirePdfAsyncRoute(baseInput)).toEqual({
      enabled: false,
      reason: "percentage_disabled",
    });
  });

  it("never routes ZDR or short-deadline work", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        zeroDataRetention: true,
        forceTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "zdr" });
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        remainingMs: FIRE_PDF_ASYNC_MIN_REMAINING_MS - 1,
        forceTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "deadline_too_close" });
  });

  it("lets a denylist override a forced team", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        forceTeamIds: "team-1",
        disableTeamIds: "team-1",
      }),
    ).toEqual({ enabled: false, reason: "team_disabled" });
  });

  it("supports team canaries and a separately gated request override", () => {
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, forceTeamIds: " team-1 " }),
    ).toEqual({ enabled: true, reason: "team_forced" });
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, requestOptIn: true }),
    ).toEqual({ enabled: false, reason: "percentage_disabled" });
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        requestOptIn: true,
        allowRequestOverride: true,
      }),
    ).toEqual({ enabled: true, reason: "request_override" });
  });

  it("uses a stable request-level percentage cohort", () => {
    expect(deterministicPercentage("same-id")).toBe(
      deterministicPercentage("same-id"),
    );
    expect(decideFirePdfAsyncRoute({ ...baseInput, percentage: 100 })).toEqual({
      enabled: true,
      reason: "percentage",
    });
  });
});

describe("FirePDF async transport helpers", () => {
  it("uses the server hint as a floor while backing off with jitter", () => {
    expect(nextPollDelay(1_000, 4_500, () => 0)).toBe(4_500);
    expect(nextPollDelay(2_000, 1_000, () => 0)).toBe(4_000);
    expect(nextPollDelay(1_000, undefined, () => 0.5)).toBe(2_200);
    expect(nextPollDelay(4_000, undefined, () => 1)).toBe(5_000);
  });

  it("does not inflate a caller deadline", () => {
    expect(computeDeadlineMs(4_000)).toBe(4_000);
  });

  it("adds the shared FirePDF bearer credential when configured", () => {
    const mutableConfig = config as typeof config & {
      FIRE_PDF_API_KEY?: string;
    };
    const original = config.FIRE_PDF_API_KEY;
    try {
      mutableConfig.FIRE_PDF_API_KEY = "shared-secret";
      expect(firePdfHeaders(true)).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer shared-secret",
      });
    } finally {
      mutableConfig.FIRE_PDF_API_KEY = original;
    }
  });
});
