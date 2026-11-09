import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  TEST_API_URL,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { idmux, Identity, scrapeTimeout } from "./lib";
import request from "supertest";
import { describe, expect, beforeAll } from "vitest";

let identity: Identity;
let lowConcurrencyIdentity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "crawl-status-cursor",
    concurrency: 100,
    credits: 1000000,
  });
  lowConcurrencyIdentity = await idmux({
    name: "crawl-status-cursor-cancel",
    concurrency: 1,
    credits: 1000000,
  });
}, 10000);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getStatus(path: string, apiKey: string) {
  const res = await request(TEST_API_URL)
    .get(path)
    .set("Authorization", `Bearer ${apiKey}`)
    .send();
  expect(res.statusCode).toBe(200);
  return res.body;
}

// Follows `next` like the SDKs do, with a hop cap so a cursor that never ends
// fails the test instead of hanging it.
async function followCursor(firstPath: string, apiKey: string) {
  const docs: any[] = [];
  let path: string | undefined = firstPath;
  let hops = 0;
  let last: any;
  while (path !== undefined && hops < 20) {
    last = await getStatus(path, apiKey);
    docs.push(...last.data);
    hops++;
    path = last.next
      ? new URL(last.next).pathname + new URL(last.next).search
      : undefined;
  }
  return { docs, hops, last, ended: path === undefined };
}

async function startBatch(urls: string[], apiKey: string) {
  const res = await request(TEST_API_URL)
    .post("/v2/batch/scrape")
    .set("Authorization", `Bearer ${apiKey}`)
    .set("Content-Type", "application/json")
    .send({ urls });
  expect(res.statusCode).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.id as string;
}

describe("Crawl status cursor", () => {
  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "ends after the last page of a completed job",
    async () => {
      const apiKey = identity.apiKey;
      const id = await startBatch(
        Array.from(
          { length: 5 },
          (_, i) => `${TEST_SUITE_WEBSITE}?cursorDone=${i}`,
        ),
        apiKey,
      );

      let status: any;
      do {
        if (status) await sleep(250);
        status = await getStatus(`/v2/batch/scrape/${id}`, apiKey);
      } while (status.status === "scraping");
      expect(status.status).toBe("completed");

      const result = await followCursor(
        `/v2/batch/scrape/${id}?limit=2`,
        apiKey,
      );
      expect(result.ended).toBe(true);
      expect(result.hops).toBe(Math.max(1, Math.ceil(status.completed / 2)));
      expect(result.docs).toHaveLength(status.completed);
      expect(result.last.next).toBeUndefined();
    },
    scrapeTimeout * 2,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "ends after the last page of a cancelled job",
    async () => {
      const apiKey = lowConcurrencyIdentity.apiKey;
      const id = await startBatch(
        Array.from(
          { length: 20 },
          (_, i) => `${TEST_SUITE_WEBSITE}?cursorCancel=${i}`,
        ),
        apiKey,
      );

      let status: any;
      do {
        if (status) await sleep(100);
        status = await getStatus(`/v2/batch/scrape/${id}`, apiKey);
      } while (status.status === "scraping" && status.completed < 1);
      expect(status.status).toBe("scraping");

      const cancel = await request(TEST_API_URL)
        .delete(`/v2/batch/scrape/${id}`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send();
      expect(cancel.statusCode).toBe(200);

      const completedBeforeCancel = status.completed;
      status = await getStatus(`/v2/batch/scrape/${id}`, apiKey);
      expect(status.status).toBe("cancelled");

      const result = await followCursor(
        `/v2/batch/scrape/${id}?limit=2`,
        apiKey,
      );
      expect(result.ended).toBe(true);
      expect(result.last.next).toBeUndefined();
      expect(result.docs.length).toBeGreaterThanOrEqual(completedBeforeCancel);

      // No more than 20 documents can ever exist, so this page is past the end.
      const past = await getStatus(`/v2/batch/scrape/${id}?skip=20`, apiKey);
      expect(past.data).toHaveLength(0);
      expect(past.next).toBeUndefined();
    },
    scrapeTimeout * 2,
  );
});
