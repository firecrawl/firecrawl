import {
  sumCreditLines,
  groupCreditsByFeature,
  retagAllLines,
  isDocumentContentType,
  applyDocumentTag,
  type CreditLine,
} from "./credit-lines";
import {
  calculateCreditLines,
  calculateCreditsToBeBilled,
} from "./scrape-billing";
import {
  CREDITS_FEATURE_ID,
  JSON_CREDITS_FEATURE_ID,
  DOCUMENT_CREDITS_FEATURE_ID,
  SEARCH_CREDITS_FEATURE_ID,
} from "../services/autumn/autumn.service";

const CREDITS = CREDITS_FEATURE_ID;
const JSON_C = JSON_CREDITS_FEATURE_ID;
const DOC = DOCUMENT_CREDITS_FEATURE_ID;

describe("credit-lines helpers", () => {
  const lines: CreditLine[] = [
    { feature: CREDITS, credits: 1, reason: "base" },
    { feature: JSON_C, credits: 4, reason: "json" },
    { feature: CREDITS, credits: 2, reason: "pdf-pages" },
  ];

  it("sums all lines", () => {
    expect(sumCreditLines(lines)).toBe(7);
  });

  it("groups by feature, dropping non-positive buckets", () => {
    expect(groupCreditsByFeature(lines)).toEqual({ [CREDITS]: 3, [JSON_C]: 4 });
    expect(
      groupCreditsByFeature([{ feature: CREDITS, credits: 0, reason: "x" }]),
    ).toEqual({});
  });

  it("retags every line onto one feature (endpoint precedence)", () => {
    expect(
      groupCreditsByFeature(retagAllLines(lines, SEARCH_CREDITS_FEATURE_ID)),
    ).toEqual({
      [SEARCH_CREDITS_FEATURE_ID]: 7,
    });
  });

  it("moves only CREDITS lines to DOCUMENT_CREDITS, leaving format pools", () => {
    expect(groupCreditsByFeature(applyDocumentTag(lines))).toEqual({
      [DOC]: 3,
      [JSON_C]: 4,
    });
  });

  it("matches document content types exactly (before parameters)", () => {
    expect(isDocumentContentType("application/pdf")).toBe(true);
    expect(isDocumentContentType("application/pdf; charset=binary")).toBe(true);
    expect(isDocumentContentType("APPLICATION/MSWORD")).toBe(true);
    // regression: substring false positive
    expect(isDocumentContentType("application/pdfx")).toBe(false);
    expect(isDocumentContentType("text/html")).toBe(false);
    expect(isDocumentContentType(undefined)).toBe(false);
  });
});

// Minimal argument helper mirroring calculateCreditsToBeBilled's shape.
const linesFor = (options: any, document: any) =>
  calculateCreditLines(
    options,
    { teamId: "team-id", orgId: null } as any,
    document,
    { totalCost: 0 } as any,
    {} as any,
  );

const successMeta = (extra: Record<string, unknown> = {}) => ({
  metadata: { statusCode: 200, proxyUsed: "basic", ...extra },
});

describe("calculateCreditLines — per-feature split", () => {
  it("bills a plain scrape as 1 general credit", async () => {
    const lines = await linesFor(
      { formats: [{ type: "markdown" }] },
      successMeta(),
    );
    expect(groupCreditsByFeature(lines)).toEqual({ [CREDITS]: 1 });
  });

  it("splits JSON output into base (CREDITS) + premium (JSON_CREDITS), total unchanged", async () => {
    const options = { formats: [{ type: "json" }] };
    const lines = await linesFor(options, successMeta());
    expect(groupCreditsByFeature(lines)).toEqual({ [CREDITS]: 1, [JSON_C]: 4 });
    // total still 5, matching the legacy scalar
    expect(sumCreditLines(lines)).toBe(5);
    expect(
      await calculateCreditsToBeBilled(
        options as any,
        { teamId: "t", orgId: null } as any,
        successMeta() as any,
        { totalCost: 0 } as any,
        {} as any,
      ),
    ).toBe(5);
  });

  it("meters a parsed PDF (base + extra pages) entirely against DOCUMENT_CREDITS", async () => {
    const lines = await linesFor(
      { formats: [{ type: "markdown" }] },
      successMeta({ contentType: "application/pdf", numPages: 3 }),
    );
    // base 1 + 2 extra pages = 3, all on the document pool
    expect(groupCreditsByFeature(lines)).toEqual({ [DOC]: 3 });
  });

  it("meters an office document against DOCUMENT_CREDITS", async () => {
    const lines = await linesFor(
      { formats: [{ type: "markdown" }] },
      successMeta({
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    expect(groupCreditsByFeature(lines)).toEqual({ [DOC]: 1 });
  });

  it("splits JSON extraction over a PDF across DOCUMENT_CREDITS + JSON_CREDITS", async () => {
    const lines = await linesFor(
      { formats: [{ type: "json" }] },
      successMeta({ contentType: "application/pdf" }),
    );
    expect(groupCreditsByFeature(lines)).toEqual({ [DOC]: 1, [JSON_C]: 4 });
  });
});
