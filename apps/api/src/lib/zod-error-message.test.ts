import { z } from "zod";
import { formatZodIssues } from "./zod-error-message";

function issuesFor(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return result.error.issues;
}

describe("formatZodIssues", () => {
  it("names the offending field for a plain type mismatch", () => {
    const schema = z.object({ retentionDays: z.number().int() });
    expect(formatZodIssues(issuesFor(schema, { retentionDays: "30" }))).toBe(
      "retentionDays: Invalid input: expected number, received string",
    );
  });

  it("descends into union branches and prefixes the union's path", () => {
    const schema = z.object({
      targets: z.array(
        z.union([
          z.strictObject({
            type: z.literal("scrape"),
            urls: z.array(z.string()).min(1),
          }),
          z.strictObject({ type: z.literal("crawl"), url: z.string() }),
        ]),
      ),
    });

    // The shape issue #4054 most likely hit: `url` where `urls` belongs.
    const message = formatZodIssues(
      issuesFor(schema, { targets: [{ type: "scrape", url: "https://a.com" }] }),
    );

    expect(message).toContain("targets.0.urls");
    // The crawl branch only failed on its discriminator -- reporting it would
    // send the caller after the wrong field.
    expect(message).not.toContain('expected "crawl"');
  });

  it("does not mistake a failed enum for a branch discriminator", () => {
    const schema = z.object({
      targets: z.array(
        z.union([
          z.strictObject({
            type: z.literal("scrape"),
            urls: z.array(z.string()).min(1),
          }),
          z.strictObject({
            type: z.literal("search"),
            queries: z.array(z.string()).min(1),
            window: z.enum(["1h", "24h", "7d"]),
          }),
        ]),
      ),
    });

    const message = formatZodIssues(
      issuesFor(schema, {
        targets: [{ type: "search", queries: ["ai"], window: "3d" }],
      }),
    );

    // `window` permits several values, so it is an ordinary field the caller got
    // wrong -- not a discriminator disqualifying the search branch.
    expect(message).toContain("targets.0.window");
    expect(message).not.toContain("targets.0.urls");
  });

  it("prefers the branch that got furthest into the structure", () => {
    // No literal discriminator here, so both branches are "informative" and the
    // discriminator rule cannot break the tie. The array branch fails at its own
    // root (it never matched the shape); the object branch matched and is
    // complaining about a real field, which is what the caller needs to see.
    const schema = z.object({
      field: z.union([
        z.array(z.string()),
        z.strictObject({ mode: z.enum(["a", "b"]), depth: z.number() }),
      ]),
    });

    const message = formatZodIssues(
      issuesFor(schema, { field: { mode: "zzz", depth: 1 } }),
    );

    expect(message).toContain("field.mode");
    expect(message).not.toContain("expected array");
  });

  it("caps the message and reports how many issues were elided", () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
    });
    const message = formatZodIssues(issuesFor(schema, {}));
    expect(message).toContain("a:");
    expect(message).toContain("b:");
    expect(message).toContain("and 2 more validation errors");
    expect(message).not.toContain("c:");
  });

  it("returns null when there is nothing worth showing", () => {
    expect(formatZodIssues([])).toBeNull();
  });
});
