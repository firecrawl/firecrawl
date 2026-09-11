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
            source: "news",
            position: 1,
            detail: "The release announcement does not discuss retries.",
            basis: "output",
          },
        ],
      }).observations,
    ).toHaveLength(2);
  });
  it("accepts a scrape failure without requesting investigation", () => {
    expect(
      keylessFeedbackSchema.safeParse({
        ...base,
        endpoint: "scrape",
        observations: [
          {
            kind: "failure",
            detail: "The request timed out before returning any text.",
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
        observations: [
          {
            kind: "table",
            detail: "The returned table has no column headings.",
            location: "Page 2, first table",
            basis: "output",
          },
          {
            kind: "completeness",
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
      observations: [
        {
          kind: "table",
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
