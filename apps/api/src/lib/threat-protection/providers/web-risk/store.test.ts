import { config } from "../../../../config";
import {
  WEB_RISK_THREAT_TYPES,
  WebRiskListStore,
  type ThreatListMeta,
} from "./store";
import { createFakeWebRiskRedis, sha256 } from "./testing";

function meta(overrides: Partial<ThreatListMeta> = {}): ThreatListMeta {
  return {
    versionToken: "dG9rZW4=",
    checksum: "",
    count: 0,
    syncedAt: new Date().toISOString(),
    nextDiffAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function sorted(entries: Buffer[]): Buffer[] {
  return [...entries].sort(Buffer.compare);
}

describe("WebRiskListStore", () => {
  it("round-trips entries through the bucketed layout", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);

    // Hashes spread across many buckets, plus one long (8-byte) entry.
    const fullHashes = Array.from({ length: 500 }, (_, i) =>
      sha256(`domain-${i}.example/`),
    );
    const entries = sorted([
      ...fullHashes.map(hash => hash.subarray(0, 4)),
      sha256("long-entry.example/").subarray(0, 8),
    ]);

    for (const type of WEB_RISK_THREAT_TYPES) {
      await store.writeVersion(type, entries, meta({ count: entries.length }));
    }

    const roundTripped = await store.loadEntries(
      "MALWARE",
      (await store.getPointer("MALWARE"))!.version,
    );
    expect(roundTripped.map(e => e.toString("hex"))).toEqual(
      entries.map(e => e.toString("hex")),
    );

    // Membership: a listed 4-byte prefix hits, an unlisted hash misses.
    const hit = await store.lookup([fullHashes[123]]);
    expect(hit).toMatchObject({ status: "ok" });
    if (hit.status === "ok") {
      expect(hit.hits.length).toBe(3); // present in every list
      expect(hit.hits[0].prefix.equals(fullHashes[123].subarray(0, 4))).toBe(
        true,
      );
    }

    const miss = await store.lookup([sha256("clean.example/")]);
    expect(miss).toMatchObject({ status: "ok", hits: [] });

    // Long entries match by prefix comparison against the full hash.
    const longHit = await store.lookup([sha256("long-entry.example/")]);
    expect(longHit).toMatchObject({ status: "ok" });
    if (longHit.status === "ok") {
      expect(longHit.hits[0].prefix.length).toBe(8);
    }
  });

  it("reports unavailable until every list has a version", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);

    expect(await store.lookup([sha256("x/")])).toEqual({
      status: "unavailable",
    });

    await store.writeVersion("MALWARE", [], meta());
    expect(await store.lookup([sha256("x/")])).toEqual({
      status: "unavailable",
    });

    await store.writeVersion("SOCIAL_ENGINEERING", [], meta());
    await store.writeVersion("UNWANTED_SOFTWARE", [], meta());
    expect(await store.lookup([sha256("x/")])).toMatchObject({ status: "ok" });
  });

  it("reports stale when a list exceeds the staleness threshold", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);
    const staleSyncedAt = new Date(
      Date.now() - (config.THREAT_LIST_STALENESS_SECONDS + 60) * 1000,
    ).toISOString();

    await store.writeVersion("MALWARE", [], meta({ syncedAt: staleSyncedAt }));
    await store.writeVersion("SOCIAL_ENGINEERING", [], meta());
    await store.writeVersion("UNWANTED_SOFTWARE", [], meta());

    const result = await store.lookup([sha256("x/")]);
    expect(result).toMatchObject({ status: "stale" });
    if (result.status === "stale") {
      expect(result.ageSeconds).toBeGreaterThan(
        config.THREAT_LIST_STALENESS_SECONDS,
      );
    }
  });

  it("swaps the version pointer atomically and serves the new content", async () => {
    const redis = createFakeWebRiskRedis();
    const store = new WebRiskListStore(redis);

    const v1Hash = sha256("v1-only.example/");
    const v2Hash = sha256("v2-only.example/");

    for (const type of WEB_RISK_THREAT_TYPES) {
      await store.writeVersion(type, [v1Hash.subarray(0, 4)], meta());
    }
    const v1 = (await store.getPointer("MALWARE"))!.version;

    expect(await store.lookup([v1Hash])).toMatchObject({
      status: "ok",
      hits: [expect.anything(), expect.anything(), expect.anything()],
    });

    await store.writeVersion("MALWARE", [v2Hash.subarray(0, 4)], meta());
    const v2 = (await store.getPointer("MALWARE"))!.version;
    expect(v2).not.toBe(v1);

    // New content served, old content gone from the MALWARE list.
    const v2Lookup = await store.lookup([v2Hash]);
    expect(v2Lookup).toMatchObject({ status: "ok" });
    if (v2Lookup.status === "ok") {
      expect(v2Lookup.hits.map(h => h.threatType)).toEqual(["MALWARE"]);
    }
    const v1Lookup = await store.lookup([v1Hash]);
    if (v1Lookup.status === "ok") {
      expect(v1Lookup.hits.map(h => h.threatType)).toEqual([
        "SOCIAL_ENGINEERING",
        "UNWANTED_SOFTWARE",
      ]);
    }

    // The superseded version's data is retired (grace TTL), not readable as
    // the current version.
    expect((await store.getPointer("MALWARE"))!.version).toBe(v2);
  });
});
