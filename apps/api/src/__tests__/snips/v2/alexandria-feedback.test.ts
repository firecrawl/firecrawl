import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux, Identity } from "./lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { config } from "../../../config";

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

  // A successful catalogue read opens the window, and the API records it before
  // responding, so feedback sent right after sees it.
  describeIf(!!config.FIRE_EXCHANGE_URL)("within the feedback window", () => {
    const openWindow = async (apiKey = identity.apiKey) => {
      const response = await request(TEST_API_URL)
        .get("/exchange/discover")
        .set("Authorization", `Bearer ${apiKey}`);
      expect(response.statusCode).toBe(200);
    };

    beforeEach(async () => {
      await openWindow();
    });

    it("rejects feedback from a team with no recent Alexandria call", async ctx => {
      // A unique name gives a team with no activity, even on reruns.
      const fresh = await idmux({
        name: `alexandria-feedback-no-window-${Date.now()}`,
        credits: 100,
      });
      // Without idmux every identity is the same team, whose window is open.
      if (fresh.teamId === identity.teamId) ctx.skip();

      const response = await submit(body, fresh.apiKey);
      expect(response.statusCode).toBe(409);
      expect(response.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");

      await openWindow(fresh.apiKey);
      const accepted = await submit(body, fresh.apiKey);
      expect(accepted.statusCode).toBe(200);
      await deleteFeedback(accepted.body.feedbackId);
    });

    // Billing confirms refunds, so environments without it report 0 credits.
    it("records the minimum session feedback without any search or scrape job and reports its refund", async () => {
      const response = await submit(body);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        creditsRefundedToday: expect.any(Number),
        dailyRefundCap: expect.any(Number),
      });
      expect([0, 1]).toContain(response.body.creditsRefunded);
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
          objective: null,
          origin: "api",
          integration: null,
          schema_version: 2,
          credits_refunded: response.body.creditsRefunded,
        });
        expect(parent.refund_policy).toMatchObject({
          endpoint: "alexandria",
          matchedReason:
            response.body.creditsRefunded === 1
              ? "alexandria_feedback"
              : "refund_not_confirmed",
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
          requestedFunctionality:
            "Return all attachment URLs for a contract ID.",
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
      const objective = "Build a list of open federal IT contracts to bid on.";
      const response = await submit({
        ...body,
        objective,
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
          objective,
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

    it("stops refunding a website at its daily cap", async () => {
      const websiteCap = config.ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS;
      const website = {
        url: "https://www.usaspending.gov/search",
        requestedFunctionality: "List federal awards by recipient.",
      };
      const responses: request.Response[] = [];
      try {
        for (let i = 0; i <= websiteCap; i++) {
          responses.push(await submit({ ...body, requestedWebsite: website }));
        }
        for (const response of responses) {
          expect(response.statusCode).toBe(200);
        }
        const last = responses.at(-1)!;
        expect(last.body).toMatchObject({ success: true, creditsRefunded: 0 });
        const first = responses[0].body;
        if (first.creditsRefunded === 1) {
          // The team cap and earlier refunds today can stop refunds before the
          // website cap does.
          const teamRemaining =
            first.dailyRefundCap - (first.creditsRefundedToday - 1);
          const refunded = Math.min(websiteCap, teamRemaining);
          expect(responses.map(r => r.body.creditsRefunded)).toEqual([
            ...Array(refunded).fill(1),
            ...Array(websiteCap + 1 - refunded).fill(0),
          ]);
          if (websiteCap <= teamRemaining) {
            expect(last.body.websiteCapReached).toBe(true);
          }
          if (teamRemaining <= websiteCap) {
            expect(last.body.dailyCapReached).toBe(true);
          } else {
            expect(last.body.warning).toContain("www.usaspending.gov");
          }
        }
        const { parent } = await feedbackRows(last.body.feedbackId);
        expect(parent.credits_refunded).toBe(0);
      } finally {
        await Promise.all(
          responses
            .map(response => response.body.feedbackId)
            .filter(Boolean)
            .map(deleteFeedback),
        );
      }
    });
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

  it("rejects a blank objective", async () => {
    const response = await submit({ ...body, objective: " " });
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
