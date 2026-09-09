import { describe, it, expect } from "vitest";
import { z } from "zod";
import { url as urlSchemaV1 } from "../v1/types";
import { URL as urlSchemaV2 } from "../v2/types";

/**
 * Pins the ordering these schemas depend on: the string check must run before
 * the scheme is prepended.
 *
 * Were it the other way round, a missing url would be interpolated into
 * "http://undefined" — structurally a valid URL, so the only check left to fail
 * would be the top-level-domain refinement, and the caller would be told their
 * url had a bad TLD when they never sent one. Reordering reintroduces that, so
 * these tests hold the order in place.
 */
describe.each([
  ["v1", urlSchemaV1],
  ["v2", urlSchemaV2],
])("%s url schema", (_version, schema) => {
  const parse = (value: unknown) =>
    z.object({ url: schema as z.ZodType }).safeParse(value as object);

  it("reports a missing url as a type error, not a TLD complaint", () => {
    const result = parse({});

    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue.code).toBe("invalid_type");
    expect(issue.path).toEqual(["url"]);
    expect(issue.message).not.toContain("top-level domain");
  });

  it.each([[null], [123], [{}], [[]]])(
    "does not turn %s into a plausible URL",
    value => {
      const result = parse({ url: value });

      expect(result.success).toBe(false);
      expect(result.error!.issues[0].message).not.toContain("top-level domain");
    },
  );

  it("still prepends a scheme to a bare hostname", () => {
    const result = parse({ url: "example.com/path" });

    expect(result.success).toBe(true);
    expect(result.data!.url).toBe("http://example.com/path");
  });

  it("leaves an explicit scheme alone", () => {
    const result = parse({ url: "https://example.com/path" });

    expect(result.success).toBe(true);
    expect(result.data!.url).toBe("https://example.com/path");
  });

  it("still rejects a host with no usable TLD", () => {
    const result = parse({ url: "http://nodots" });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toContain("top-level domain");
  });
});
