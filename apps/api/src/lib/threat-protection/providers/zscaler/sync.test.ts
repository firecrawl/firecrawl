import type { ZscalerUrlCategory } from "./client";
import { materializeCategories, matchSyncedRules } from "./sync";

// Fixture payload following the GET /urlCategories response shape from the
// official Zscaler SDK services (urls / dbCategorizedUrls / keywords /
// keywordsRetainingParentCategory), not hand-invented fields.
const CATEGORIES: ZscalerUrlCategory[] = [
  {
    id: "CUSTOM_01",
    configuredName: "Blocked Vendors",
    customCategory: true,
    urls: ["vendor-blocked.example.com", "partner.example.com/private"],
    keywords: ["forbiddenword"],
  },
  {
    id: "CUSTOM_02",
    configuredName: "Tracked Tools",
    customCategory: true,
    dbCategorizedUrls: ["tool.example.com"],
    keywordsRetainingParentCategory: ["retainedword"],
  },
  {
    // Customer addition to a Zscaler-defined category ("URLs retaining
    // parent category" on a predefined category).
    id: "GAMBLING",
    dbCategorizedUrls: ["sweepstakes.example.com"],
  },
  {
    id: "CUSTOM_03",
    configuredName: "Port-Scoped",
    customCategory: true,
    urls: ["internal.example.com:8443"],
  },
  {
    // Pure taxonomy entry: no custom content, so no local rule.
    id: "ENTERTAINMENT",
  },
];

describe("materializeCategories", () => {
  const { taxonomy, rules } = materializeCategories(CATEGORIES);

  it("keeps every category in the taxonomy for the picker", () => {
    expect(taxonomy).toHaveLength(5);
    expect(taxonomy.map(entry => entry.id).sort()).toEqual([
      "CUSTOM_01",
      "CUSTOM_02",
      "CUSTOM_03",
      "ENTERTAINMENT",
      "GAMBLING",
    ]);
  });

  it("uses the configured name and falls back to the ID", () => {
    const byId = new Map(taxonomy.map(entry => [entry.id, entry]));
    expect(byId.get("CUSTOM_01")).toMatchObject({
      name: "Blocked Vendors",
      custom: true,
    });
    expect(byId.get("GAMBLING")).toMatchObject({
      name: "GAMBLING",
      custom: false,
    });
  });

  it("materializes rules only for categories with local content", () => {
    expect(rules.map(rule => rule.id).sort()).toEqual([
      "CUSTOM_01",
      "CUSTOM_02",
      "CUSTOM_03",
      "GAMBLING",
    ]);
  });

  it("separates reclassifying and retaining entries", () => {
    const custom01 = rules.find(rule => rule.id === "CUSTOM_01")!;
    expect(custom01.urls).toContain("vendor-blocked.example.com");
    expect(custom01.retainingUrls).toEqual([]);
    expect(custom01.keywords).toEqual(["forbiddenword"]);

    const custom02 = rules.find(rule => rule.id === "CUSTOM_02")!;
    expect(custom02.urls).toEqual([]);
    expect(custom02.retainingUrls).toEqual(["tool.example.com"]);
    expect(custom02.retainingKeywords).toEqual(["retainedword"]);
  });
});

describe("matchSyncedRules", () => {
  const { rules } = materializeCategories(CATEGORIES);

  function match(url: string) {
    return matchSyncedRules(url, rules).map(entry => ({
      id: entry.rule.id,
      reclassifies: entry.reclassifies,
    }));
  }

  it("matches a URL-list entry on the host and its subdomains", () => {
    expect(match("https://vendor-blocked.example.com/page")).toEqual([
      { id: "CUSTOM_01", reclassifies: true },
    ]);
    expect(match("https://deep.vendor-blocked.example.com/")).toEqual([
      { id: "CUSTOM_01", reclassifies: true },
    ]);
    expect(match("https://not-vendor-blocked.example.com/")).toEqual([]);
  });

  it("restricts path-scoped entries to that path", () => {
    expect(match("https://partner.example.com/private/report")).toEqual([
      { id: "CUSTOM_01", reclassifies: true },
    ]);
    expect(match("https://partner.example.com/public")).toEqual([]);
  });

  it("matches keywords anywhere in the schemeless URL, case-insensitively", () => {
    expect(match("https://anything.example.org/ForbiddenWord-page")).toEqual([
      { id: "CUSTOM_01", reclassifies: true },
    ]);
    expect(match("https://anything.example.org/?q=retainedword")).toEqual([
      { id: "CUSTOM_02", reclassifies: false },
    ]);
  });

  it("ignores ports on both the entry and the checked URL", () => {
    expect(match("https://internal.example.com:8443/console")).toEqual([
      { id: "CUSTOM_03", reclassifies: true },
    ]);
    expect(match("https://internal.example.com/console")).toEqual([
      { id: "CUSTOM_03", reclassifies: true },
    ]);
  });

  it("marks retaining-parent-category entries as non-reclassifying", () => {
    expect(match("https://tool.example.com/")).toEqual([
      { id: "CUSTOM_02", reclassifies: false },
    ]);
    expect(match("https://sweepstakes.example.com/")).toEqual([
      { id: "GAMBLING", reclassifies: false },
    ]);
  });

  it("flags keyword matches as inexact so they can never allow on their own", () => {
    const matches = matchSyncedRules(
      "https://anything.example.org/ForbiddenWord-page",
      rules,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ reclassifies: true, exact: false });

    const exactMatches = matchSyncedRules(
      "https://vendor-blocked.example.com/",
      rules,
    );
    expect(exactMatches[0]).toMatchObject({ reclassifies: true, exact: true });
  });

  it("collects every matching category", () => {
    expect(match("https://tool.example.com/forbiddenword")).toEqual(
      expect.arrayContaining([
        { id: "CUSTOM_01", reclassifies: true },
        { id: "CUSTOM_02", reclassifies: false },
      ]),
    );
  });
});
