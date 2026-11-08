import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, mergeProfiles, resolveDomainOverride } from "./config.js";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scraper-config-test-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function writeYaml(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("loadConfig", () => {
  it("returns defaults when no path is given", async () => {
    const config = await loadConfig();
    expect(config.apiUrl).toBe("http://localhost:3002");
    expect(config.cdp.url).toBe("http://localhost:9222");
    expect(config.concurrency).toBe(5);
    expect(config.profiles).toEqual({});
    expect(config.domains).toEqual({});
  });

  it("returns defaults when the file does not exist", async () => {
    const config = await loadConfig(join(dir, "does-not-exist.yaml"));
    expect(config.apiUrl).toBe("http://localhost:3002");
  });

  it("interpolates ${ENV_VAR} from process.env", async () => {
    vi.stubEnv("MY_COOKIE", "abc123");
    const path = await writeYaml(
      "envinterp.yaml",
      `domains:\n  "x.io":\n    headers:\n      Cookie: "\${MY_COOKIE}"\n`,
    );
    const config = await loadConfig(path);
    expect(config.domains["x.io"]?.headers).toEqual({ Cookie: "abc123" });
    vi.unstubAllEnvs();
  });

  it("replaces missing env vars with empty string", async () => {
    const path = await writeYaml(
      "envmissing.yaml",
      `domains:\n  "x.io":\n    headers:\n      Cookie: "\${DEFINITELY_UNSET_VAR_XYZ}"\n`,
    );
    const config = await loadConfig(path);
    expect(config.domains["x.io"]?.headers).toEqual({ Cookie: "" });
  });

  it("rejects bad shape with a clear field-path error", async () => {
    const path = await writeYaml("bad.yaml", `concurrency: "not-a-number"\n`);
    await expect(loadConfig(path)).rejects.toThrow(/concurrency/);
  });

  it("accepts engine: 'api' | 'cdp' on profiles", async () => {
    const path = await writeYaml("engine.yaml", `profiles:\n  default: { engine: cdp }\n`);
    const config = await loadConfig(path);
    expect(config.profiles["default"]?.engine).toBe("cdp");
  });

  it("rejects unknown engine values", async () => {
    const path = await writeYaml("badengine.yaml", `profiles:\n  default: { engine: rocket }\n`);
    await expect(loadConfig(path)).rejects.toThrow();
  });
});

describe("mergeProfiles", () => {
  it("later wins for scalars", () => {
    const out = mergeProfiles({ waitFor: 1000 }, { waitFor: 2000 });
    expect(out.waitFor).toBe(2000);
  });

  it("merges headers as deep object (later wins on collisions)", () => {
    const out = mergeProfiles(
      { headers: { "User-Agent": "old", Cookie: "a" } },
      { headers: { "User-Agent": "new" } },
    );
    expect(out.headers).toEqual({ "User-Agent": "new", Cookie: "a" });
  });

  it("ignores undefined inputs", () => {
    const out = mergeProfiles(undefined, { waitFor: 1000 }, undefined);
    expect(out.waitFor).toBe(1000);
  });
});

describe("resolveDomainOverride", () => {
  const config = {
    apiUrl: "http://x",
    concurrency: 1,
    retries: { attempts: 0, initialDelayMs: 0 },
    cdp: { url: "http://x" },
    profiles: {},
    domains: {
      "www.nytimes.com": { engine: "cdp" as const },
      "*.docs.io": { waitFor: 3000 },
    },
  };

  it("matches exact host", () => {
    const o = resolveDomainOverride(config, "https://www.nytimes.com/article");
    expect(o?.engine).toBe("cdp");
  });

  it("matches glob host", () => {
    const o = resolveDomainOverride(config, "https://api.docs.io/page");
    expect(o?.waitFor).toBe(3000);
  });

  it("returns undefined for unknown hosts", () => {
    expect(resolveDomainOverride(config, "https://example.com")).toBeUndefined();
  });

  it("returns undefined for unparseable URLs", () => {
    expect(resolveDomainOverride(config, "not-a-url")).toBeUndefined();
  });
});
