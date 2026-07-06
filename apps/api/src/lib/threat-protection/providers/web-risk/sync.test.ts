import { createHash } from "crypto";
import http from "http";
import { AddressInfo } from "net";
import { config } from "../../../../config";
import { runThreatListSyncPass } from "./sync";
import { WEB_RISK_THREAT_TYPES, WebRiskListStore } from "./store";
import { createFakeWebRiskRedis } from "./testing";

// Sync-loop unit tests: a local HTTP server plays Google's
// threatLists:computeDiff endpoint via the config URL override.

type DiffHandler = (threatType: string, versionToken: string | null) => object;

let server: http.Server;
let baseUrl: string;
let diffCalls: { threatType: string; versionToken: string | null }[] = [];
let diffHandler: DiffHandler = () => ({});

const originalConfig = {
  url: config.GOOGLE_WEB_RISK_API_URL,
  key: config.GOOGLE_WEB_RISK_API_KEY,
};

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/threatLists:computeDiff") {
        const threatType = url.searchParams.get("threatType") ?? "";
        const versionToken = url.searchParams.get("versionToken");
        diffCalls.push({ threatType, versionToken });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(diffHandler(threatType, versionToken)));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      config.GOOGLE_WEB_RISK_API_URL = baseUrl;
      config.GOOGLE_WEB_RISK_API_KEY = "test-key";
      resolve();
    });
  });
});

afterAll(async () => {
  config.GOOGLE_WEB_RISK_API_URL = originalConfig.url;
  config.GOOGLE_WEB_RISK_API_KEY = originalConfig.key;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  diffCalls = [];
});

function checksumOf(sortedEntries: Buffer[]): string {
  const hash = createHash("sha256");
  for (const entry of sortedEntries) hash.update(entry);
  return hash.digest("base64");
}

function sortedPrefixes(hexes: string[]): Buffer[] {
  return hexes.map(hex => Buffer.from(hex, "hex")).sort(Buffer.compare);
}

function resetResponse(entries: Buffer[], token: string): object {
  return {
    responseType: "RESET",
    additions: {
      rawHashes: [
        { prefixSize: 4, rawHashes: Buffer.concat(entries).toString("base64") },
      ],
    },
    newVersionToken: Buffer.from(token).toString("base64"),
    checksum: { sha256: checksumOf(entries) },
    recommendedNextDiff: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

describe("runThreatListSyncPass", () => {
  it("bootstraps all lists from a RESET response and stores metadata", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    const entries = sortedPrefixes(["00000001", "7fffffff", "ffffff00"]);
    diffHandler = () => resetResponse(entries, "v1");

    const ran = await runThreatListSyncPass({}, store, redis);
    expect(ran).toBe(true);
    expect(diffCalls.map(c => c.threatType).sort()).toEqual(
      [...WEB_RISK_THREAT_TYPES].sort(),
    );
    // First sync has no version token.
    expect(diffCalls.every(c => c.versionToken === null)).toBe(true);

    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = await store.getPointer(type);
      expect(pointer).not.toBeNull();
      expect(pointer!.meta.count).toBe(3);
      expect(pointer!.meta.versionToken).toBe(
        Buffer.from("v1").toString("base64"),
      );
      const stored = await store.loadEntries(type, pointer!.version);
      expect(stored.map(e => e.toString("hex"))).toEqual(
        entries.map(e => e.toString("hex")),
      );
    }
  });

  it("applies an incremental DIFF (removals by sorted index + additions)", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    const initial = sortedPrefixes([
      "11111111",
      "22222222",
      "33333333",
      "44444444",
    ]);
    diffHandler = () => resetResponse(initial, "v1");
    await runThreatListSyncPass({}, store, redis);
    diffCalls = [];

    // Remove indices 1 and 3 (22222222, 44444444), add aaaaaaaa.
    const expected = sortedPrefixes(["11111111", "33333333", "aaaaaaaa"]);
    diffHandler = () => ({
      responseType: "DIFF",
      additions: {
        rawHashes: [
          {
            prefixSize: 4,
            rawHashes: Buffer.from("aaaaaaaa", "hex").toString("base64"),
          },
        ],
      },
      removals: { rawIndices: { indices: [1, 3] } },
      newVersionToken: Buffer.from("v2").toString("base64"),
      checksum: { sha256: checksumOf(expected) },
      recommendedNextDiff: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    await runThreatListSyncPass({ force: true }, store, redis);

    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = await store.getPointer(type);
      expect(pointer!.meta.versionToken).toBe(
        Buffer.from("v2").toString("base64"),
      );
      const stored = await store.loadEntries(type, pointer!.version);
      expect(stored.map(e => e.toString("hex"))).toEqual(
        expected.map(e => e.toString("hex")),
      );
    }
    // The DIFF request carried the stored version token.
    expect(
      diffCalls.every(
        c => c.versionToken === Buffer.from("v1").toString("base64"),
      ),
    ).toBe(true);
  });

  it("rejects a malformed prefixSize instead of spinning (remote JSON is untrusted)", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    diffHandler = () => ({
      responseType: "RESET",
      additions: {
        rawHashes: [
          {
            prefixSize: 0,
            rawHashes: Buffer.from("11111111", "hex").toString("base64"),
          },
        ],
      },
      newVersionToken: Buffer.from("v1").toString("base64"),
      checksum: { sha256: checksumOf(sortedPrefixes(["11111111"])) },
    });

    // Per-list failures are logged and skipped (one bad list must not take
    // down the pass) — the important part is: no infinite loop, and nothing
    // gets published.
    await runThreatListSyncPass({}, store, redis);
    for (const type of WEB_RISK_THREAT_TYPES) {
      expect(await store.getPointer(type)).toBeNull();
    }
  });

  it("recovers from a DIFF checksum mismatch by re-syncing from scratch", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    const initial = sortedPrefixes(["11111111"]);
    diffHandler = () => resetResponse(initial, "v1");
    await runThreatListSyncPass({}, store, redis);
    diffCalls = [];

    const fresh = sortedPrefixes(["55555555", "66666666"]);
    diffHandler = (_type, versionToken) => {
      if (versionToken) {
        // Corrupt diff: checksum does not match what applying it produces.
        return {
          responseType: "DIFF",
          additions: {
            rawHashes: [
              {
                prefixSize: 4,
                rawHashes: Buffer.from("99999999", "hex").toString("base64"),
              },
            ],
          },
          newVersionToken: Buffer.from("bad").toString("base64"),
          checksum: { sha256: checksumOf(sortedPrefixes(["deadbeef"])) },
        };
      }
      return resetResponse(fresh, "v2");
    };

    await runThreatListSyncPass({ force: true }, store, redis);

    // Each list: one failed DIFF then one RESET recovery.
    expect(diffCalls.length).toBe(WEB_RISK_THREAT_TYPES.length * 2);
    for (const type of WEB_RISK_THREAT_TYPES) {
      const pointer = await store.getPointer(type);
      expect(pointer!.meta.versionToken).toBe(
        Buffer.from("v2").toString("base64"),
      );
      const stored = await store.loadEntries(type, pointer!.version);
      expect(stored.map(e => e.toString("hex"))).toEqual(
        fresh.map(e => e.toString("hex")),
      );
    }
  });

  it("respects recommendedNextDiff (unforced pass is a no-op while fresh)", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    diffHandler = () => resetResponse(sortedPrefixes(["11111111"]), "v1");
    await runThreatListSyncPass({}, store, redis);
    diffCalls = [];

    const ran = await runThreatListSyncPass({}, store, redis);
    expect(ran).toBe(true); // lock acquired…
    expect(diffCalls).toEqual([]); // …but nothing was due
  });

  it("returns false without syncing when another process holds the lock", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    await redis.set("threat_list_sync:lock", "someone-else", "EX", 60, "NX");

    const ran = await runThreatListSyncPass({}, store, redis);
    expect(ran).toBe(false);
    expect(diffCalls).toEqual([]);
  });
});
