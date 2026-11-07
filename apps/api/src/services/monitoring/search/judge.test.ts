import { parseVerdict, verdictToDecision, type SearchVerdict } from "./judge";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";

const v = (over: Partial<SearchVerdict>): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  concept: "x",
  rationale: "x",
  ...over,
});

describe("verdictToDecision", () => {
  it("notifies on relevant + fresh + trusted + alert", () => {
    expect(verdictToDecision(v({}))).toBe("notify");
  });
  it("ignores when not relevant", () => {
    expect(verdictToDecision(v({ relevant: false }))).toBe("ignore");
  });
});

describe("parseVerdict", () => {
  it("returns null for non-objects / missing relevant", () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict("x")).toBeNull();
    expect(parseVerdict({})).toBeNull();
  });
  it("coerces a valid verdict", () => {
    expect(
      parseVerdict({
        relevant: true,
        alertAction: "alert",
        concept: "c",
        rationale: "r",
      }),
    ).toMatchObject({ relevant: true, alertAction: "alert", concept: "c" });
  });
});

describe("dedupe", () => {
  it("canonicalizes (host/www/trailing slash/case)", () => {
    expect(canonicalizeUrl("https://www.Example.com/Path/")).toBe(
      canonicalizeUrl("https://example.com/path"),
    );
  });
  it("same URL → same fingerprint even when title/snippet drift (URL-keyed)", () => {
    const a = stableSerpFingerprint({
      url: "https://a.com",
      title: "T",
      snippet: "S",
    });
    const b = stableSerpFingerprint({
      url: "https://www.A.com/",
      title: "different title",
      snippet: "reworded snippet",
    });
    expect(a).toBe(b);
  });
  it("different URL → different fingerprint", () => {
    const a = stableSerpFingerprint({ url: "https://a.com", title: "T" });
    const b = stableSerpFingerprint({ url: "https://b.com", title: "T" });
    expect(a).not.toBe(b);
  });
});

describe("verdict defenses", () => {
  it("notify requires a non-empty concept (event dedup needs a label)", () => {
    expect(verdictToDecision(v({ concept: "" }))).toBe("watch");
    expect(verdictToDecision(v({ concept: "  " }))).toBe("watch");
  });
});
