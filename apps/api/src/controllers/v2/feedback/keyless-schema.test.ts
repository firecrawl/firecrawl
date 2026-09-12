import { keylessFeedbackSchema } from "./keyless-schema";

const base = {
  jobId: "00000000-0000-4000-8000-000000000001",
  rating: "partial",
  task: "Find the documented retry behavior",
  assessment: "The output answered only part of the retry question.",
};

describe("keyless feedback evidence", () => {
  it("accepts explicit useful and irrelevant results in independent groups", () => {
    expect(
      keylessFeedbackSchema.parse({
        ...base,
        endpoint: "search",
        observations: [
          {
            kind: "useful",
            source: "web",
            position: 1,
            detail: "The API reference describes retry intervals.",
            basis: "output",
          },
          {
            kind: "irrelevant",
            reason: "off_topic",
            source: "news",
            position: 1,
            detail: "The release announcement does not discuss retries.",
            basis: "output",
          },
        ],
      }).observations,
    ).toHaveLength(2);
  });
  it("accepts an observed wrong-success scrape", () => {
    expect(
      keylessFeedbackSchema.safeParse({
        ...base,
        endpoint: "scrape",
        observations: [
          {
            kind: "wrong_success",
            reason: "empty",
            detail: "The successful request returned no usable text.",
            basis: "output",
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("keeps parse expectations distinct from source comparisons", () => {
    expect(
      keylessFeedbackSchema.safeParse({
        ...base,
        endpoint: "parse",
        docClass: "unknown",
        observations: [
          {
            kind: "table",
            reason: "structure",
            detail: "The returned table has no column headings.",
            page: 2,
            basis: "output",
          },
          {
            kind: "completeness",
            reason: "sections_dropped",
            detail: "I expected an appendix, but have not checked the source.",
            basis: "expectation",
          },
        ],
      }).success,
    ).toBe(true);
  });
  it.each([
    { endpoint: "map", observations: [] },
    {
      endpoint: "search",
      observations: [
        {
          kind: "useful",
          detail: "A useful reference for the task.",
          basis: "output",
        },
      ],
    },
    {
      endpoint: "parse",
      docClass: "unknown",
      observations: [
        {
          kind: "table",
          reason: "structure",
          detail: "The table differs from the original source.",
          basis: "source_comparison",
        },
      ],
    },
    {
      endpoint: "scrape",
      observations: [
        {
          kind: "table",
          reason: "structure",
          detail: "This belongs to a different category.",
          basis: "output",
        },
      ],
    },
    {
      endpoint: "scrape",
      observations: [{ kind: "correct", detail: "   ", basis: "output" }],
    },
  ])("rejects unsupported or unsubstantiated evidence", payload => {
    expect(
      keylessFeedbackSchema.safeParse({ ...base, ...payload }).success,
    ).toBe(false);
  });
});

const evidence = {
  detail: "The returned content supports this observation.",
  basis: "output",
};
const cases = [
  [
    "search",
    "irrelevant",
    [
      "aggregator_over_official",
      "off_topic",
      "stale",
      "wrong_content_type",
      "snippet_misleading",
      "blocked_or_paywalled",
    ],
    { position: 1 },
  ],
  [
    "scrape",
    "wrong_success",
    [
      "blocked_shell",
      "login_required",
      "paywall",
      "empty",
      "wrong_page",
      "stale",
      "wrong_locale",
    ],
    {},
  ],
  [
    "scrape",
    "incomplete",
    [
      "partial_content",
      "dynamic_content",
      "pagination",
      "main_content_stripped",
      "format_lost",
    ],
    {},
  ],
  ["scrape", "incorrect", ["wrong", "hallucinated", "missing_fields"], {}],
  ["parse", "text_ocr", ["misread_chars", "garbled", "missing_text"], {}],
  ["parse", "table", ["structure", "cells_glued", "digits"], {}],
  [
    "parse",
    "completeness",
    ["pages_missing", "truncated_at_max_pages", "sections_dropped"],
    {},
  ],
  ["parse", "incorrect", ["wrong", "hallucinated", "missing_fields"], {}],
] as const;
function payload(endpoint: string, item: object) {
  return {
    ...base,
    endpoint,
    ...(endpoint === "parse" ? { docClass: "unknown" } : {}),
    observations: [{ ...evidence, ...item }],
  };
}
it.each(cases)(
  "enforces %s %s reason subtypes",
  (endpoint, kind, reasons, fields) => {
    for (const reason of reasons)
      expect(
        keylessFeedbackSchema.safeParse(
          payload(endpoint, { kind, ...fields, reason }),
        ).success,
      ).toBe(true);
    for (const reason of [undefined, "unrecognized", "off_topic"])
      if (!reasons.some(valid => valid === reason))
        expect(
          keylessFeedbackSchema.safeParse(
            payload(endpoint, { kind, ...fields, reason }),
          ).success,
        ).toBe(false);
  },
);
it.each([
  "web_general",
  "social",
  "business",
  "research",
  "developer",
  "news",
  "government",
  "finance",
  "other",
])("accepts missing vertical %s without inventing a topic", vertical => {
  expect(
    keylessFeedbackSchema.safeParse(
      payload("search", { kind: "missing", vertical }),
    ).success,
  ).toBe(true);
  expect(
    keylessFeedbackSchema.safeParse(
      payload("search", { kind: "useful", position: 1, vertical }),
    ).success,
  ).toBe(true);
});
it.each([
  "correct",
  "formula",
  "chart_figure",
  "reading_order",
  "headers_footers",
  "headings_formatting",
  "images_dropped",
])("accepts Parse %s without a reason subtype", kind => {
  expect(
    keylessFeedbackSchema.safeParse(
      payload("parse", { kind, page: 1, format: "html" }),
    ).success,
  ).toBe(true);
  expect(
    keylessFeedbackSchema.safeParse(payload("parse", { kind, reason: "wrong" }))
      .success,
  ).toBe(false);
});
it.each(["born_digital", "scanned", "mixed", "unknown"])(
  "records docClass %s once per submission",
  docClass => {
    expect(
      keylessFeedbackSchema.safeParse({
        ...payload("parse", { kind: "correct" }),
        docClass,
      }).success,
    ).toBe(true);
  },
);
it("requires a valid submission-level docClass", () => {
  for (const docClass of [undefined, "pdf"])
    expect(
      keylessFeedbackSchema.safeParse({
        ...payload("parse", { kind: "correct" }),
        docClass,
      }).success,
    ).toBe(false);
});
it.each([
  ["search", { kind: "missing" }],
  ["search", { kind: "missing", vertical: "other", topic: "x".repeat(201) }],
  [
    "search",
    {
      kind: "missing",
      vertical: "other",
      knownSources: ["file:///etc/passwd"],
    },
  ],
  [
    "search",
    {
      kind: "missing",
      vertical: "other",
      knownSources: Array(21).fill("https://example.com"),
    },
  ],
  ["search", { kind: "useful", position: 0 }],
  ["search", { kind: "useful", position: 1, engine: "index" }],
  ["search", { kind: "useful", position: 1, category: "developer" }],
  ["search", { kind: "useful", position: 1.5 }],
  ["search", { kind: "useful", position: 1, reason: "off_topic" }],
  ["scrape", { kind: "correct", reason: "wrong" }],
  ["scrape", { kind: "correct", retryOutcome: "Observed a different outcome" }],
  ["scrape", { kind: "failure" }],
  ["scrape", { kind: "correct", location: "x".repeat(201) }],
  ["parse", { kind: "correct", page: 0 }],
  ["parse", { kind: "correct", page: 1.5 }],
  ["parse", { kind: "correct", docClass: "unknown" }],
  ["parse", { kind: "layout" }],
])("rejects invalid %s observation %j", (endpoint, item) => {
  expect(keylessFeedbackSchema.safeParse(payload(endpoint, item)).success).toBe(
    false,
  );
});
it("retains HTTP(S) missing sources and source comparison evidence", () => {
  expect(
    keylessFeedbackSchema.safeParse(
      payload("search", {
        kind: "missing",
        vertical: "developer",
        knownSources: ["http://example.com", "https://example.com/docs"],
      }),
    ).success,
  ).toBe(true);
  const comparison = {
    reference: "Document page 2",
    detail: "The source has three columns and output has two.",
  };
  const item = {
    kind: "table",
    reason: "structure",
    basis: "source_comparison",
  };
  expect(
    keylessFeedbackSchema.safeParse(payload("parse", { ...item, comparison }))
      .success,
  ).toBe(true);
  expect(keylessFeedbackSchema.safeParse(payload("parse", item)).success).toBe(
    false,
  );
});
