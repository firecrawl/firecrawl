import {
  enrichmentTarget,
  enrichmentFormat,
  enrichmentResponse,
} from "./scrape-enrichment";

const target = {
  url: "https://www.linkedin.com/in/jane",
  entity: "person" as const,
  format: "json" as const,
};
const payload = {
  status: "matched",
  entity: "person",
  url: target.url,
  profile: { name: "Jane" },
  source: {
    provider: "apollo",
    capability: "people/match",
    attribution: "Apollo",
  },
  steps: [
    { provider: "apollo", capability: "people/match", status: "matched" },
  ],
  providerCredits: 30,
  billingComplete: true,
};
function response(data: Record<string, unknown> = payload) {
  return {
    status: 200,
    scrapeId: "scrape-id",
    body: {
      success: true,
      creditsCost: 0,
      results: [
        { provider: "firecrawl", capability: "enrich", creditsCost: 0, data },
      ],
    },
  };
}

it.each([
  "https://ca.linkedin.com/in/jane?trk=abc",
  "http://linkedin.com/in/jane/",
  "https://m.linkedin.com/in/jane#about",
])("canonicalizes supported profile %s", url => {
  expect(enrichmentTarget(url, "team", "other, team")).toEqual({
    url: target.url,
    entity: "person",
  });
});
it("routes companies separately and defaults rollout off", () => {
  expect(
    enrichmentTarget("https://uk.linkedin.com/company/example", "team", "team"),
  ).toEqual({
    url: "https://www.linkedin.com/company/example",
    entity: "company",
  });
  expect(enrichmentTarget(target.url, "team", "")).toBeNull();
  expect(enrichmentTarget(target.url, "team", "other-team")).toBeNull();
});
it.each([
  "https://linkedin.com/jobs/123",
  "https://linkedin.com/posts/jane",
  "https://linkedin.com/in/jane/posts",
  "https://linkedin.com.evil.com/in/jane",
  "https://evil.com/in/jane",
  "https://linkedin.com:443/in/jane",
  "http://linkedin.com:80/in/jane",
  "https://user@linkedin.com/in/jane",
  "https://linkedin.com/in/a%2Fb",
  "https://linkedin.com/in/a%252Fb",
  "https://linkedin.com/in/%FF",
  "https://linkedin.com/in/a\\b",
  "https://linkedin.com/in/",
  "https://linkedin.com/in/a%20b",
])("does not intercept unsupported or ambiguous URL %s", url => {
  expect(enrichmentTarget(url, "team", "team")).toBeNull();
});
it("accepts one deterministic format, rejecting ignored scrape options", () => {
  expect(enrichmentFormat({ url: target.url })).toBe("markdown");
  expect(
    enrichmentFormat({
      url: target.url,
      formats: ["json"],
      integration: "cli",
      onlyMainContent: false,
    }),
  ).toBe("json");
  expect(
    enrichmentFormat({ url: target.url, formats: [{ type: "json" }] }),
  ).toBe("json");
  for (const options of [
    { formats: ["json", "markdown"] },
    { formats: ["screenshot"] },
    { formats: [{ type: "json", prompt: "extract emails" }] },
    { actions: [{ type: "click", selector: "button" }] },
    { headers: { authorization: "secret" } },
    { zeroDataRetention: true },
    { __agentInterop: {} },
  ])
    expect(enrichmentFormat({ url: target.url, ...options })).toBeNull();
});
it("returns native JSON with attribution and already charged provider credits", () => {
  expect(enrichmentResponse(response(), target, "team")).toMatchObject({
    status: 200,
    body: {
      success: true,
      data: {
        json: { name: "Jane" },
        enrichment: {
          source: payload.source,
          creditsUsed: 30,
          billingComplete: true,
        },
      },
    },
  });
});
it("returns markdown without a second provider request", () => {
  expect(
    enrichmentResponse(
      response({ ...payload, markdown: "# Jane" }),
      { ...target, format: "markdown" },
      "team",
    ),
  ).toMatchObject({ body: { data: { markdown: "# Jane" } } });
});
it.each(["disabled", "unavailable"])(
  "links %s setup to the requesting team",
  status => {
    const result = enrichmentResponse(
      response({ ...payload, status, providerCredits: 0, steps: [] }),
      target,
      "team-id",
    );
    expect(result).toMatchObject({
      status: 403,
      body: { success: false, code: "ENRICHMENT_SETUP_REQUIRED" },
    });
    const body = result.body as any;
    const url = new URL(body.details.action.url);
    expect(url.searchParams.get("redirect")).toBe(
      "/app/t/team-id/alexandria?enrichment=true",
    );
  },
);
it("reports stopped access separately from a miss and preserves uncertain billing", () => {
  expect(
    enrichmentResponse(
      response({
        ...payload,
        status: "stopped",
        billingComplete: false,
        steps: [
          {
            provider: "apollo",
            capability: "people/match",
            status: "error",
            error: { code: "provider_error", status: 403 },
          },
        ],
      }),
      target,
      "team",
    ),
  ).toMatchObject({
    status: 403,
    body: {
      code: "ENRICHMENT_ACCESS_REQUIRED",
      details: { action: expect.any(Object), billingComplete: false },
    },
  });
});
it.each([
  ["not_found", 404, "ENRICHMENT_NOT_FOUND"],
  ["budget_exceeded", 402, "ENRICHMENT_BUDGET_EXCEEDED"],
  ["stopped", 502, "ENRICHMENT_PROVIDER_ERROR"],
])("maps %s without pretending success", (status, http, code) => {
  expect(
    enrichmentResponse(response({ ...payload, status }), target, "team"),
  ).toMatchObject({ status: http, body: { success: false, code } });
});
it("preserves timeout without a setup action", () => {
  const result = enrichmentResponse(
    response({
      ...payload,
      status: "stopped",
      steps: [
        {
          provider: "apollo",
          capability: "people/match",
          status: "error",
          error: { code: "deadline_exceeded", status: 504 },
        },
      ],
    }),
    target,
    "team",
  );
  expect(result.status).toBe(504);
  expect((result.body as any).details.action).toBeUndefined();
});
it.each([
  { entity: "company" },
  { url: "https://www.linkedin.com/in/someone-else" },
  { profile: undefined },
  { source: undefined },
  { billingComplete: false },
  { status: "unknown" },
])("rejects malformed or mismatched profile %j", patch => {
  expect(
    enrichmentResponse(response({ ...payload, ...patch }), target, "team")
      .status,
  ).toBe(502);
});
it("preserves an upstream request failure", () => {
  const failed = {
    status: 429,
    body: { success: false, error: "Rate limited" },
  };
  expect(enrichmentResponse(failed, target, "team")).toEqual(failed);
});
