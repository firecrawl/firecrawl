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
    requestedWebsite: {
      url: "https://sam.gov",
      requestedFunctionality:
        "Find active contracts by agency and export their attachments as CSV.",
    },
    rationale: "Found contract summaries but could not retrieve attachments.",
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
        comment: body.rationale,
        credits_refunded: 0,
        metadata: {
          endpoint: "alexandria",
          requestedWebsite: body.requestedWebsite,
          rationale: body.rationale,
        },
      });
    } finally {
      await db
        .delete(schema.search_feedback)
        .where(eq(schema.search_feedback.id, response.body.feedbackId));
    }
  });

  it("persists provider issues and both new and existing capability feedback", async () => {
    const providerFeedback = [
      {
        name: "sam.gov",
        issue: "insufficient_coverage",
        why: "The provider returned summaries without attachments.",
      },
    ];
    const capabilityFeedback = [
      {
        name: "download-attachments",
        provider: "sam.gov",
        issue: "new_capability_request",
        why: "Need source documents to compare contract requirements.",
        requestedFunctionality: "Return all attachment URLs for a contract ID.",
      },
      {
        name: "contracts",
        provider: "sam.gov",
        issue: "execution_error",
        why: "The second page request timed out.",
      },
    ];
    const response = await submit({
      ...body,
      providerFeedback,
      capabilityFeedback,
    });
    expect(response.statusCode).toBe(200);
    try {
      const [row] = await db
        .select()
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, response.body.feedbackId));
      expect(row.metadata).toEqual({
        schemaVersion: 1,
        endpoint: "alexandria",
        requestedWebsite: body.requestedWebsite,
        rationale: body.rationale,
        providerFeedback,
        capabilityFeedback,
      });
      expect(row.comment).toBe(body.rationale);
    } finally {
      await db
        .delete(schema.search_feedback)
        .where(eq(schema.search_feedback.id, response.body.feedbackId));
    }
  });

  it.each(["endpoint", "rating", "requestedWebsite", "rationale"])(
    "requires %s",
    async field => {
      const response = await submit({ ...body, [field]: undefined });
      expect(response.statusCode).toBe(400);
      expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    },
  );

  it("requires the website functionality brief", async () => {
    const response = await submit({
      ...body,
      requestedWebsite: { url: body.requestedWebsite.url },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  });

  it("requires requested functionality for a new capability request", async () => {
    const response = await submit({
      ...body,
      capabilityFeedback: [
        {
          name: "download-attachments",
          provider: "sam.gov",
          issue: "new_capability_request",
          why: "Need the source documents for each contract.",
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  });

  it("requires authentication", async () => {
    const response = await request(TEST_API_URL)
      .post("/v2/feedback")
      .send(body);
    expect(response.statusCode).toBe(401);
  });
});
