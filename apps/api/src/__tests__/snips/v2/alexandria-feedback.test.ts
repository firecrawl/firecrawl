import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux, Identity } from "./lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

const feedbackRows = async (feedbackId: string) => {
  const [[parent], providers, capabilities] = await Promise.all([
    db
      .select()
      .from(schema.alexandria_feedback)
      .where(eq(schema.alexandria_feedback.id, feedbackId)),
    db
      .select()
      .from(schema.alexandria_feedback_providers)
      .where(eq(schema.alexandria_feedback_providers.feedback_id, feedbackId))
      .orderBy(asc(schema.alexandria_feedback_providers.position)),
    db
      .select()
      .from(schema.alexandria_feedback_capabilities)
      .where(
        eq(schema.alexandria_feedback_capabilities.feedback_id, feedbackId),
      )
      .orderBy(asc(schema.alexandria_feedback_capabilities.position)),
  ]);
  return { parent, providers, capabilities };
};

// Child rows cascade from the parent delete.
const deleteFeedback = (feedbackId: string) =>
  db
    .delete(schema.alexandria_feedback)
    .where(eq(schema.alexandria_feedback.id, feedbackId));

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
      const { parent, providers, capabilities } = await feedbackRows(
        response.body.feedbackId,
      );
      expect(parent).toMatchObject({
        team_id: identity.teamId,
        api_version: "v2",
        rating: "partial",
        requested_url: body.requestedWebsite.url,
        requested_host: "sam.gov",
        requested_functionality: body.requestedWebsite.requestedFunctionality,
        rationale: body.rationale,
        origin: "api",
        integration: null,
        schema_version: 2,
      });
      expect(providers).toEqual([]);
      expect(capabilities).toEqual([]);
    } finally {
      await deleteFeedback(response.body.feedbackId);
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
        issue: "missing_capability",
        why: "The provider has no attachment download capability.",
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
      integration: "cli",
    });
    expect(response.statusCode).toBe(200);
    const feedbackId = response.body.feedbackId;
    try {
      const { parent, providers, capabilities } =
        await feedbackRows(feedbackId);
      expect(parent).toMatchObject({
        rationale: body.rationale,
        integration: "cli",
      });
      expect(providers).toEqual(
        providerFeedback.map((entry, position) =>
          expect.objectContaining({
            feedback_id: feedbackId,
            team_id: identity.teamId,
            position,
            ...entry,
          }),
        ),
      );
      expect(capabilities).toEqual(
        capabilityFeedback.map(
          ({ requestedFunctionality, ...entry }, position) =>
            expect.objectContaining({
              feedback_id: feedbackId,
              team_id: identity.teamId,
              position,
              requested_functionality: requestedFunctionality ?? null,
              ...entry,
            }),
        ),
      );
    } finally {
      await deleteFeedback(feedbackId);
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

  it("rejects unsupported integration identifiers", async () => {
    const response = await submit({ ...body, integration: "unsupported" });
    expect(response.statusCode).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  });
});
