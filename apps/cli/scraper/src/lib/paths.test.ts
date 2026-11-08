import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUserPath } from "./paths.js";

describe("resolveUserPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveUserPath("/etc/hosts")).toBe("/etc/hosts");
  });

  it("passes through the stdout sentinel", () => {
    expect(resolveUserPath("-")).toBe("-");
  });

  it("resolves relative paths against SCRAPER_INVOKE_CWD when set", () => {
    vi.stubEnv("SCRAPER_INVOKE_CWD", "/tmp/somewhere");
    expect(resolveUserPath("rel.md")).toBe("/tmp/somewhere/rel.md");
  });

  it("falls back to process.cwd() when SCRAPER_INVOKE_CWD is unset", () => {
    vi.stubEnv("SCRAPER_INVOKE_CWD", "");
    expect(resolveUserPath("rel.md")).toBe(resolve(process.cwd(), "rel.md"));
  });
});
