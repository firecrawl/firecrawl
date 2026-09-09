import { expect, it, vi } from "vitest";
vi.mock("../../lib/withAuth", () => ({ withAuth: (fn: unknown) => fn }));
vi.mock("./batch_billing", () => ({
  queueBillingOperation: vi.fn(async () => ({ success: true })),
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { trackCredits: vi.fn(async () => true) },
  featureIdForBillingEndpoint: () => "credits",
}));
import { billTeam } from "./credit_billing";
import { queueBillingOperation } from "./batch_billing";
it("passes the usage receipt to the existing billing queue", async () => {
  const receipt = {
    usageRequestId: "request",
    billingReference: "exchange:request",
  };
  const billing = { endpoint: "scrape" as const, chargeId: "exchange:request" };
  await billTeam("team", 2, 7, billing, undefined, receipt);
  expect(queueBillingOperation).toHaveBeenCalledWith(
    "team",
    2,
    7,
    billing,
    false,
    true,
    receipt,
  );
});
