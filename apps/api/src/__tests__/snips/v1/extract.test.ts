import request from "supertest";
import { TEST_API_URL, TEST_SUITE_WEBSITE } from "../lib";
import { sunsetOf } from "../../../lib/deprecations";

it("POST /v1/extract answers 410 with the migration guide", async () => {
  const res = await request(TEST_API_URL)
    .post("/v1/extract")
    .set("Content-Type", "application/json")
    .send({ urls: [TEST_SUITE_WEBSITE], prompt: "Extract the page title." });

  expect(res.statusCode).toBe(410);
  expect(res.body.code).toBe("ENDPOINT_REMOVED");
  expect(res.body.replacement).toBe("/v2/scrape");
  expect(res.body.documentation_url).toBe(
    "https://docs.firecrawl.dev/migrating-from-extract",
  );
  expect(res.headers["sunset"]).toBe(
    new Date(sunsetOf("v1_extract")).toUTCString(),
  );
}, 30000);
