import { enrichmentTarget, enrichmentSetupError } from "./scrape-enrichment";

it.each([
  "https://ca.linkedin.com/in/jane?trk=abc",
  "http://linkedin.com/in/jane/",
  "https://m.linkedin.com/in/jane#about",
])("recognizes supported profile %s", url => {
  expect(enrichmentTarget(url)).toEqual({
    url: "https://www.linkedin.com/in/jane",
    entity: "person",
  });
});
it("recognizes company profiles", () => {
  expect(enrichmentTarget("https://uk.linkedin.com/company/example")).toEqual({
    url: "https://www.linkedin.com/company/example",
    entity: "company",
  });
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
])("leaves other URLs unchanged: %s", url => {
  expect(enrichmentSetupError(url, "team")).toBeNull();
});
it.each(["customer-team", "another-team"])(
  "provides setup guidance for any authenticated team: %s",
  team => {
    const result = enrichmentSetupError(
      "https://ca.linkedin.com/in/jane",
      team,
    )!;
    const url = new URL(result.details.action.url);
    expect(url.origin).toBe("https://www.firecrawl.dev");
    expect(url.searchParams.get("redirect")).toBe(
      `/app/t/${team}/alexandria?enrichment=true`,
    );
    expect(result.error).toContain(result.details.action.url);
  },
);
it("encodes the team identifier without allowing redirect injection", () => {
  const result = enrichmentSetupError(
    "https://linkedin.com/company/example",
    "team?next=https://evil.com",
  )!;
  const url = new URL(result.details.action.url);
  expect(url.searchParams.get("redirect")).toBe(
    "/app/t/team%3Fnext%3Dhttps%3A%2F%2Fevil.com/alexandria?enrichment=true",
  );
});
