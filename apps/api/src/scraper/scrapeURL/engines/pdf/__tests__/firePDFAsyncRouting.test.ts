import { config } from "../../../../../config";
import {
  firePdfRouteDecisionsTotal,
  firePdfRouteRemainingSeconds,
} from "../fire-pdf/metrics";
import {
  decideFirePdfAsyncRoute,
  deterministicPercentage,
  FIRE_PDF_ASYNC_MIN_REMAINING_MS,
  firePdfFeaturesLabel,
  recordFirePdfRoute,
} from "../fire-pdf/routing";
import { counterValue, makeMeta } from "./firePDFAsyncFixtures";
import {
  computeByReferenceDeadlineMs,
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

  it("routes crawl/batch children on their own cohort", () => {
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        bulkOrigin: true,
        bulkOriginPercentage: 100,
      }),
    ).toEqual({ enabled: true, reason: "bulk_origin" });
    // Traffic-neutral by default, like every other cohort.
    expect(decideFirePdfAsyncRoute({ ...baseInput, bulkOrigin: true })).toEqual(
      { enabled: false, reason: "percentage_disabled" },
    );
    // Never applies to non-bulk scrapes.
    expect(
      decideFirePdfAsyncRoute({ ...baseInput, bulkOriginPercentage: 100 }),
    ).toEqual({ enabled: false, reason: "percentage_disabled" });
  });

  it("keeps the hard exclusions ahead of the bulk cohort", () => {
    const bulk = {
      ...baseInput,
      bulkOrigin: true,
      bulkOriginPercentage: 100,
    };
    expect(
      decideFirePdfAsyncRoute({ ...bulk, zeroDataRetention: true }),
    ).toEqual({ enabled: false, reason: "zdr" });
    expect(
      decideFirePdfAsyncRoute({
        ...bulk,
        remainingMs: FIRE_PDF_ASYNC_MIN_REMAINING_MS - 1,
      }),
    ).toEqual({ enabled: false, reason: "deadline_too_close" });
    expect(
      decideFirePdfAsyncRoute({ ...bulk, disableTeamIds: "team-1" }),
    ).toEqual({ enabled: false, reason: "team_disabled" });
  });

  it("cohorts bulk and general percentages independently", () => {
    // The bulk cohort hashes a prefixed key, so a scrape's position in
    // one cohort says nothing about its position in the other.
    const scrapeId = "cohort-independence-probe";
    expect(deterministicPercentage(`bulk-origin:${scrapeId}`)).not.toBe(
      deterministicPercentage(scrapeId),
    );
    // A bulk scrape outside its cohort still falls through to the
    // general percentage.
    expect(
      decideFirePdfAsyncRoute({
        ...baseInput,
        bulkOrigin: true,
        bulkOriginPercentage: 0,
        percentage: 100,
      }),
    ).toEqual({ enabled: true, reason: "percentage" });
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

  it("page-scales the by-reference job deadline independently of the caller", () => {
    // 10min base + pages × 1.25s, floored at the caller window, capped at
    // MAX_DEADLINE_MS. The caller's own polling stops at its window; the
    // decoupled job deadline is what lets the job finish server-side.
    // Base covers burst queue wait (measured 12-14min); per-page covers
    // the scanned worst case (~1.3s/page p90), not the text median.
    const TEN_MIN = 10 * 60 * 1_000;
    // Small doc, tiny caller window → base dominates.
    expect(computeByReferenceDeadlineMs(60_000, 100)).toBe(TEN_MIN + 125_000);
    // Big doc → page term dominates, capped at 30 min.
    expect(computeByReferenceDeadlineMs(60_000, 6_543)).toBe(30 * 60 * 1_000);
    // The 931-page starvation case (2026-08-27): queue wait ate a
    // 12.8-min deadline down to 84s of processing. Now: 29.4min.
    expect(computeByReferenceDeadlineMs(60_000, 931)).toBe(
      TEN_MIN + 931 * 1_250,
    );
    // A scanned 798-pager needs ~17min of OCR; its budget now clears
    // that even before the queue-wait base is spent.
    expect(computeByReferenceDeadlineMs(60_000, 798)).toBe(
      TEN_MIN + 798 * 1_250,
    );
    // A caller with a LONGER explicit window than the page-scaled need
    // keeps its window (never advertise less than the caller has).
    expect(computeByReferenceDeadlineMs(25 * 60 * 1_000, 100)).toBe(
      25 * 60 * 1_000,
    );
    // No pages estimate → base + caller floor semantics still hold.
    expect(computeByReferenceDeadlineMs(undefined, undefined)).toBe(TEN_MIN);
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

describe("FirePDF route decision telemetry", () => {
  it("labels page-aware features in a fixed order", () => {
    const none = { pageMarkdown: false, blocks: false, pageMarkers: false };
    expect(firePdfFeaturesLabel(none)).toBe("none");
    expect(firePdfFeaturesLabel({ ...none, pageMarkdown: true })).toBe("pages");
    expect(
      firePdfFeaturesLabel({
        pageMarkdown: true,
        blocks: true,
        pageMarkers: true,
      }),
    ).toBe("pages+blocks+markers");
    expect(
      firePdfFeaturesLabel({ ...none, pageMarkers: true, blocks: true }),
    ).toBe("blocks+markers");
  });

  it("counts a sync decision with its reason, logs it, and records the time left", async () => {
    const labels = {
      source_kind: "pdf",
      path: "sync",
      reason: "zdr",
      features: "pages",
      zdr: "true",
    };
    const before = await counterValue(firePdfRouteDecisionsTotal, labels);
    const syncPdf = (
      vals: Awaited<
        ReturnType<typeof firePdfRouteRemainingSeconds.get>
      >["values"],
      metricName: string,
      le?: number,
    ) =>
      vals.find(
        v =>
          v.metricName === metricName &&
          v.labels.path === "sync" &&
          v.labels.source_kind === "pdf" &&
          (le === undefined || (v.labels as Record<string, unknown>).le === le),
      )?.value ?? 0;
    const BUCKET = "firecrawl_fire_pdf_route_remaining_seconds_bucket";
    const COUNT = "firecrawl_fire_pdf_route_remaining_seconds_count";
    const { values: histBefore } = await firePdfRouteRemainingSeconds.get();

    const meta = makeMeta({
      internalOptions: { zeroDataRetention: true, teamId: "team-x" },
    });
    meta.abort.scrapeTimeout.mockReturnValue(15_000);
    recordFirePdfRoute(meta, {
      sourceKind: "pdf",
      path: "sync",
      reason: "zdr",
      features: "pages",
    });

    expect(await counterValue(firePdfRouteDecisionsTotal, labels)).toBe(
      before + 1,
    );
    const { values: histAfter } = await firePdfRouteRemainingSeconds.get();
    // 15 s lands in the le=15 bucket, not the one below it.
    expect(syncPdf(histAfter, BUCKET, 15)).toBe(
      syncPdf(histBefore, BUCKET, 15) + 1,
    );
    expect(syncPdf(histAfter, BUCKET, 10)).toBe(
      syncPdf(histBefore, BUCKET, 10),
    );
    expect(syncPdf(histAfter, COUNT)).toBe(syncPdf(histBefore, COUNT) + 1);
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Routing FirePDF request to sync /ocr",
      expect.objectContaining({
        event: "fire_pdf_sync_routed",
        reason: "zdr",
        source_kind: "pdf",
        remaining_ms: 15_000,
      }),
    );
  });

  it("uses the remaining time captured before the attempt when one is passed", async () => {
    const bucket = async (le: number) =>
      (await firePdfRouteRemainingSeconds.get()).values.find(
        v =>
          v.metricName ===
            "firecrawl_fire_pdf_route_remaining_seconds_bucket" &&
          v.labels.path === "sync" &&
          v.labels.source_kind === "pdf" &&
          (v.labels as Record<string, unknown>).le === le,
      )?.value ?? 0;
    const le30Before = await bucket(30);
    const le45Before = await bucket(45);

    const meta = makeMeta();
    meta.abort.scrapeTimeout.mockReturnValue(2_000);
    recordFirePdfRoute(meta, {
      sourceKind: "pdf",
      path: "sync",
      reason: "outside_percentage",
      features: "none",
      remainingMs: 45_000,
    });
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Routing FirePDF request to sync /ocr",
      expect.objectContaining({ remaining_ms: 45_000 }),
    );
    // 45 s, not the 2 s the scrape has left now: le=45 moves, le=30 doesn't.
    expect(await bucket(45)).toBe(le45Before + 1);
    expect(await bucket(30)).toBe(le30Before);
  });

  it("counts async decisions without a second log line and skips the histogram when there is no deadline", async () => {
    const labels = {
      source_kind: "pdf",
      path: "async",
      reason: "by_reference",
      features: "none",
      zdr: "false",
    };
    const before = await counterValue(firePdfRouteDecisionsTotal, labels);
    const { values: histBefore } = await firePdfRouteRemainingSeconds.get();
    const countOf = (vals: typeof histBefore) =>
      vals.find(
        v =>
          v.metricName === "firecrawl_fire_pdf_route_remaining_seconds_count" &&
          v.labels.path === "async",
      )?.value ?? 0;

    const meta = makeMeta();
    meta.abort.scrapeTimeout.mockReturnValue(undefined);
    recordFirePdfRoute(meta, {
      sourceKind: "pdf",
      path: "async",
      reason: "by_reference",
      features: "none",
    });

    expect(await counterValue(firePdfRouteDecisionsTotal, labels)).toBe(
      before + 1,
    );
    const { values: histAfter } = await firePdfRouteRemainingSeconds.get();
    expect(countOf(histAfter)).toBe(countOf(histBefore));
    expect(meta.logger.info).not.toHaveBeenCalled();
  });
});
