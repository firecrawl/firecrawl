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

it("carries the Exchange receipt into the durable billing queue", async () => {
  const exchange = {
    accessEventId: "receipt",
    billingReference: "exchange:receipt",
  };
  const billing = { endpoint: "scrape" as const, chargeId: "exchange:receipt" };
  await billTeam("team", 2, 7, billing, undefined, exchange);
  expect(queueBillingOperation).toHaveBeenCalledWith(
    "team",
    2,
    7,
    billing,
    false,
    true,
    exchange,
  );
});
