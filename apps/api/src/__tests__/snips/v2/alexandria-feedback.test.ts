import request from "supertest";
import { eq } from "drizzle-orm";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux, Identity } from "./lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

describeIf(TEST_PRODUCTION)("Alexandria session feedback", () => {
  let identity: Identity;
  const body = {
    endpoint: "alexandria",
    rating: "partial",
    requestedWebsite: "https://sam.gov",
    requestedVertical: "government",
  };
  const submit = (payload: object, apiKey = identity.apiKey) =>
    request(TEST_API_URL)
      .post("/v2/feedback")
      .set("Authorization", `Bearer ${apiKey}`)
      .send(payload);

  beforeAll(async () => {
    identity = await idmux({ name: "alexandria-feedback", credits: 1000 });
  });

  it("records the minimum session feedback without any search or scrape job", async () => {
    const response = await submit(body);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ success: true, creditsRefunded: 0 });
    expect(response.body.feedbackId).toEqual(expect.any(String));
    try {
      const [row] = await db
        .select()
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, response.body.feedbackId));
      expect(row).toMatchObject({
        endpoint: "alexandria",
        team_id: identity.teamId,
        job_id: null,
        search_id: null,
        request_id: null,
        job_status: null,
        overall_rating: "partial",
        credits_refunded: 0,
        metadata: {
          endpoint: "alexandria",
          requestedWebsite: body.requestedWebsite,
          requestedVertical: "government",
        },
      });
    } finally {
      await db
        .delete(schema.search_feedback)
        .where(eq(schema.search_feedback.id, response.body.feedbackId));
    }
  });

  it.each(["rating", "requestedWebsite", "requestedVertical"])(
    "requires %s",
    async field => {
      const response = await submit({ ...body, [field]: undefined });
      expect(response.statusCode).toBe(400);
      expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    },
  );

  it("requires authentication", async () => {
    const response = await request(TEST_API_URL)
      .post("/v2/feedback")
      .send(body);
    expect(response.statusCode).toBe(401);
  });
});
