import {
  DEVELOPER_SEARCH_QUERY_KEYS,
  developerSearchSchema,
} from "./research-proxy";

describe("developer search upstream contract", () => {
  it("forwards exactly the upstream parameter surface", () => {
    expect(DEVELOPER_SEARCH_QUERY_KEYS).toEqual([
      "query",
      "k",
      "types",
      "repos",
      "sources",
      "passages",
      "language",
      "topic",
      "license",
      "min_stars",
      "max_stars",
      "archived",
      "fork",
      "skills",
    ]);
  });

  it("keeps the schema and the forwarded key list in step", () => {
    expect(Object.keys(developerSearchSchema.shape).sort()).toEqual(
      [...DEVELOPER_SEARCH_QUERY_KEYS, "origin", "integration"].sort(),
    );
  });

  it("takes skills=only and refuses any other value", () => {
    expect(
      developerSearchSchema.safeParse({ query: "q", skills: "only" }).success,
    ).toBe(true);
    expect(
      developerSearchSchema.safeParse({ query: "q", skills: "true" }).success,
    ).toBe(false);
    expect(
      developerSearchSchema.safeParse({ query: "q", skills: "" }).success,
    ).toBe(false);
  });
});
