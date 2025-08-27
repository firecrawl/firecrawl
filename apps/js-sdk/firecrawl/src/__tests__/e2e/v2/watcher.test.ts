import Firecrawl from "../../../index";
import { config } from "dotenv";
import { describe, test, expect, beforeAll } from "@jest/globals";
import { getIdentity } from "./utils/idmux";

config();

const API_URL = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-watcher" });
  client = new Firecrawl({ apiKey, apiUrl: API_URL });
});

describe("v2.watcher e2e", () => {
  test("crawl watcher minimal", async () => {
    // client is initialized in beforeAll
    const start = await client.startCrawl("https://docs.firecrawl.dev", { limit: 3 });

    expect(typeof start.id).toBe("string");

    const watcher = client.watcher(start.id, { pollInterval: 2 });

    let snapshots = 0;
    let documents = 0;

    watcher.on("snapshot", (snap: any) => {
      snapshots += 1;
      expect(["scraping", "completed", "failed", "cancelled"]).toContain(snap.status);
      expect(typeof snap.completed).toBe("number");
      expect(typeof snap.total).toBe("number");
    });

    watcher.on("document", (_doc: any) => {
      documents += 1;
    });

    const final = await new Promise<any>(async (resolve) => {
      watcher.on("done", (payload: any) => {
        resolve(payload);
      });
      watcher.on("error", (err: any) => {
        resolve(err);
      });
      await watcher.start();
    });

    expect(["completed", "failed", "cancelled"]).toContain(final.status);
    expect(Array.isArray(final.data)).toBe(true);
    expect(typeof final.id).toBe("string");
    expect(snapshots).toBeGreaterThanOrEqual(1);
    expect(documents).toBeGreaterThanOrEqual(0);
    watcher.close();
  }, 240_000);

  test("batch watcher with options (kind, pollInterval, timeout)", async () => {
    // client is initialized in beforeAll
    const urls = [
      "https://docs.firecrawl.dev",
      "https://firecrawl.dev",
    ];

    const start = await client.startBatchScrape(urls, { options: { formats: ["markdown"] }, ignoreInvalidURLs: true });
    expect(typeof start.id).toBe("string");

    const watcher = client.watcher(start.id, { kind: "batch", pollInterval: 2, timeout: 180 });

    let snapshots = 0;
    let gotCompleted = false;

    watcher.on("snapshot", (snap: any) => {
      snapshots += 1;
      if (snap.status === "completed") gotCompleted = true;
      expect(["scraping", "completed", "failed", "cancelled"]).toContain(snap.status);
    });

    const final = await new Promise<any>(async (resolve) => {
      watcher.on("done", (payload: any) => {
        resolve(payload);
      });
      watcher.on("error", (err: any) => {
        resolve(err);
      });
      await watcher.start();
    });

    expect(["completed", "failed", "cancelled"]).toContain(final.status);
    expect(Array.isArray(final.data)).toBe(true);
    expect(typeof final.id).toBe("string");
    expect(snapshots).toBeGreaterThanOrEqual(1);
    expect(gotCompleted || final.status !== "completed").toBe(true);
    watcher.close();
  }, 300_000);
});

