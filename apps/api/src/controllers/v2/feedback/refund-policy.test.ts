import { computeRefundPolicy } from "./refund-policy";
import type { FeedbackJobRow } from "./internal-types";

vi.mock("../../../config", () => ({
  config: { FEEDBACK_REFUND_ENABLED: true },
}));

function job(refundClass: FeedbackJobRow["refund_class"]): FeedbackJobRow {
  return {
    endpoint: "scrape",
    id: "job-id",
    request_id: "request-id",
    team_id: "team-id",
    credits_cost: 12,
    created_at: new Date().toISOString(),
    is_successful: true,
    options: null,
    refund_class: refundClass,
  };
}

describe("precomputed feedback refund classes", () => {
  it("uses the stored PDF policy without scrape options", () => {
    expect(computeRefundPolicy(job("scrape_pdf"), "bad")).toMatchObject({
      desiredRefund: 3,
      policy: {
        matchedReason: "scrape_pdf_feedback",
        maxCredits: 10,
      },
    });
  });

  it("uses the stored basic scrape policy without scrape options", () => {
    expect(computeRefundPolicy(job("scrape_basic"), "partial")).toMatchObject({
      desiredRefund: 1,
      policy: { matchedReason: "scrape_feedback" },
    });
  });
});

describe("interact and browser session feedback", () => {
  it.each(["interact", "browser"] as const)(
    "has no refund for %s feedback",
    endpoint => {
      const session = { ...job(undefined), endpoint, credits_cost: 0 };

      for (const rating of ["good", "partial", "bad"] as const) {
        expect(computeRefundPolicy(session, rating)).toMatchObject({
          desiredRefund: 0,
          policy: {
            endpoint,
            mode: "none",
            matchedReason: "zero_billed_credits",
          },
        });
      }
    },
  );

  it.each(["interact", "browser"] as const)(
    "has no refund for %s feedback even if a row carried billed credits",
    endpoint => {
      expect(
        computeRefundPolicy({ ...job("scrape_basic"), endpoint }, "bad"),
      ).toMatchObject({
        desiredRefund: 0,
        policy: {
          endpoint,
          mode: "none",
          matchedReason: "endpoint_not_refundable",
        },
      });
    },
  );
});
