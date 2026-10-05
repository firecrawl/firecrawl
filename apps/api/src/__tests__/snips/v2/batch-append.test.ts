import request from "supertest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  idmux,
  type Identity,
  scrapeTimeout,
  TEST_API_URL,
  TEST_SUITE_WEBSITE,
  testIf,
} from "../lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "batch-append",
    concurrency: 10,
    credits: 1000,
  });
});

describe.each(["v1", "v2"])("%s completed batch append", version => {
  testIf(ALLOW_TEST_SUITE_WEBSITE)(
    "completes a new batch and rejects terminal append without adding documents",
    async () => {
      const source = `${TEST_SUITE_WEBSITE}/?appendSource=${crypto.randomUUID()}`;
      const endpoint = `/${version}/batch/scrape`;
      const start = await request(TEST_API_URL)
        .post(endpoint)
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({ urls: [source], formats: ["markdown"] });
      expect(start.statusCode).toBe(200);
      expect(start.body.success).toBe(true);

      const statusPath = `${endpoint}/${start.body.id}`;
      let status: any;
      const deadline = Date.now() + scrapeTimeout;
      do {
        const result = await request(TEST_API_URL)
          .get(statusPath)
          .set("Authorization", `Bearer ${identity.apiKey}`);
        expect(result.statusCode).toBe(200);
        status = result.body;
        if (status.status !== "scraping") break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);

      expect(status.status).toBe("completed");
      expect(status.completed).toBe(1);
      expect(status.data).toHaveLength(1);
      expect(status.data[0].metadata.sourceURL).toBe(source);

      const append = await request(TEST_API_URL)
        .post(endpoint)
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({
          appendToId: start.body.id,
          urls: [`${TEST_SUITE_WEBSITE}/?appendNew=${crypto.randomUUID()}`],
          formats: ["markdown"],
        });
      expect(append.statusCode, JSON.stringify(append.body)).toBe(409);
      expect(append.body).toMatchObject({
        success: false,
        error: expect.stringMatching(/new batch/i),
      });

      const after = await request(TEST_API_URL)
        .get(statusPath)
        .set("Authorization", `Bearer ${identity.apiKey}`);
      expect(after.statusCode).toBe(200);
      expect(after.body.status).toBe("completed");
      expect(after.body.total).toBe(1);
      expect(after.body.completed).toBe(1);
      expect(after.body.data).toHaveLength(1);
    },
    scrapeTimeout * 2,
  );
});
