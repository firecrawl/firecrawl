#!/usr/bin/env node
// Fetches a prebuilt firecrawl-rs binary for this platform from GitHub
// Releases, falling back to building from source with napi/cargo.
//
// Binaries are content-addressed: the release tag is derived from a hash of
// this directory's sources (see sourceHash), so a checkout whose native code
// matches a published build downloads instead of compiling. PRs that change
// the Rust code have no release for their hash yet and build from source.
//
// Escape hatches:
//   FIRECRAWL_RS_FORCE_BUILD=1   always build from source
//   FIRECRAWL_RS_RELEASE_REPO    override the GitHub repo (owner/name)
//   GITHUB_TOKEN                 used for the download when set (private forks)
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = process.env.FIRECRAWL_RS_RELEASE_REPO ?? "firecrawl/firecrawl";
const stampPath = join(root, ".prebuilt-hash");

const EXCLUDED_DIRS = new Set(["node_modules", "target", "npm", ".git"]);
// Build outputs living at the package root; never hash inputs.
const GENERATED = /^(index\.js|index\.d\.ts|browser\.js|\.prebuilt-hash|.*\.node)$/;

function sourceHash() {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        if (entry.name === ".DS_Store") continue;
        if (dir === root && GENERATED.test(entry.name)) continue;
        files.push(relative(root, abs).split(sep).join("/"));
      }
    }
  })(root);
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function platformName() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    let isMusl = false;
    try {
      isMusl = !process.report.getReport().header.glibcVersionRuntime;
    } catch {
      isMusl = false;
    }
    if (isMusl) return null;
    return arch === "x64" ? "linux-x64-gnu" : "linux-arm64-gnu";
  }
  return null;
}

async function download(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "firecrawl-rs-install", ...headers },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns name -> download function for the release's assets. Public repos
// use plain release download URLs; with GITHUB_TOKEN set, the GitHub API is
// used instead so private repos (forks) work too.
async function assetFetchers(tag) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    return name => download(`${base}/${name}`);
  }
  const auth = { Authorization: `Bearer ${token}` };
  const release = JSON.parse(
    (await download(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, auth)).toString("utf8"),
  );
  const assets = new Map(release.assets.map(a => [a.name, a.url]));
  return name => {
    const url = assets.get(name);
    if (!url) throw new Error(`asset ${name} not in release ${tag}`);
    return download(url, { ...auth, Accept: "application/octet-stream" });
  };
}

function buildFromSource(hash) {
  console.log("firecrawl-rs: building from source (napi build --release)...");
  const result = spawnSync("pnpm", ["exec", "napi", "build", "--platform", "--release"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") {
    console.error("firecrawl-rs: pnpm not found; cannot build from source.");
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      "firecrawl-rs: source build failed. A Rust toolchain (rustup.rs) is required when no prebuilt binary is available.",
    );
    process.exit(result.status ?? 1);
  }
  writeFileSync(stampPath, `${hash}\n`);
}

async function main() {
  const hash = sourceHash();

  if (process.argv.includes("--hash")) {
    console.log(hash);
    return;
  }

  const platform = platformName();
  const binary = platform ? `firecrawl-rs.${platform}.node` : null;

  if (
    binary &&
    existsSync(join(root, binary)) &&
    existsSync(join(root, "index.js")) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === hash
  ) {
    console.log(`firecrawl-rs: ${binary} already up to date for ${hash}.`);
    return;
  }

  if (process.env.FIRECRAWL_RS_FORCE_BUILD) {
    console.log("firecrawl-rs: FIRECRAWL_RS_FORCE_BUILD is set.");
    buildFromSource(hash);
    return;
  }

  if (!platform) {
    console.log(`firecrawl-rs: no prebuilt binaries for ${process.platform}/${process.arch}.`);
    buildFromSource(hash);
    return;
  }

  try {
    const fetchAsset = await assetFetchers(`native-bin-${hash}`);
    const sums = (await fetchAsset("SHA256SUMS")).toString("utf8");
    const expected = new Map(
      sums
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const [sum, name] = line.trim().split(/\s+/);
          return [name.replace(/^\.\//, ""), sum];
        }),
    );

    const wanted = [binary, "index.js", "index.d.ts"];
    if (expected.has("browser.js")) wanted.push("browser.js");

    for (const name of wanted) {
      const body = await fetchAsset(name);
      const actual = createHash("sha256").update(body).digest("hex");
      if (expected.get(name) !== actual) {
        throw new Error(`checksum mismatch for ${name}`);
      }
      writeFileSync(join(root, name), body);
    }
    writeFileSync(stampPath, `${hash}\n`);
    console.log(`firecrawl-rs: downloaded prebuilt ${binary} (native-bin-${hash}).`);
  } catch (error) {
    console.log(`firecrawl-rs: prebuilt download unavailable (${error.message}); falling back to source build.`);
    buildFromSource(hash);
  }
}

await main();
