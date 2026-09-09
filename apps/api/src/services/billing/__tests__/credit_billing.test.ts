import { vi } from "vitest";

// vi.mock is hoisted; factory-referenced values must be created in vi.hoisted().
// (Jest didn't hoist jest.mock here because `jest` was imported from @jest/globals.)
const {
  withAuth,
  queueBillingOperation,
  trackCredits,
  refundCredits,
  isRoutedThroughFirebill,
} = vi.hoisted(() => ({
  withAuth: vi.fn((fn: any) => fn),
  queueBillingOperation: vi.fn<(args: any[]) => Promise<any>>(),
  trackCredits: vi.fn<(args: any) => Promise<boolean>>(),
  refundCredits: vi.fn<(args: any) => Promise<void>>(),
  isRoutedThroughFirebill: vi.fn<(teamId: string) => Promise<boolean>>(),
}));

vi.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

vi.mock("../batch_billing", () => ({
  queueBillingOperation: (...args: any[]) => queueBillingOperation(args),
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
    isRoutedThroughFirebill,
  },
  featureIdForBillingEndpoint: (endpoint?: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
}));

vi.mock("../../notification/email_notification", () => ({
  sendNotification: vi.fn(),
}));
vi.mock("../../redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { billTeam } from "../credit_billing";

beforeEach(() => {
  vi.clearAllMocks();
  queueBillingOperation.mockResolvedValue({ success: true });
  trackCredits.mockResolvedValue(true);
  refundCredits.mockResolvedValue(undefined);
  isRoutedThroughFirebill.mockResolvedValue(false);
});

describe("billTeam", () => {
  it("derives firebill idempotency keys from chargeId, and omits them without one", async () => {
    await billTeam("team-1", 3, 123, {
      endpoint: "search",
      jobId: "job-9",
      chargeId: "job-9",
    });
    expect(trackCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: "fc:track:search:job-9" }),
    );

    await billTeam("team-1", 3, 123, { endpoint: "search", jobId: "job-9" });
    expect(trackCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: undefined }),
    );
  });

  it("skips the compensating refund on the firebill route — the charge stands", async () => {
    isRoutedThroughFirebill.mockResolvedValue(true);
    queueBillingOperation.mockResolvedValueOnce({
      success: false,
      message: "enqueue failed",
    });
    trackCredits.mockResolvedValueOnce(true);

    await billTeam("team-1", 3, 123, {
      endpoint: "map",
      jobId: "map-1",
      chargeId: "map-1",
    });

    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("gives the compensating refund its own fc:refund key", async () => {
    queueBillingOperation.mockResolvedValueOnce({
      success: false,
      message: "enqueue failed",
    });
    trackCredits.mockResolvedValueOnce(true);

    await billTeam("team-1", 3, 123, {
      endpoint: "map",
      jobId: "map-1",
      chargeId: "map-1",
    });

    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "fc:refund:map:map-1" }),
    );
  });

  it("marks billing as already tracked when request tracking succeeds", async () => {
    await billTeam("team-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      true,
    ]);
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 3,
      properties: {
        source: "billTeam",
        endpoint: "search",
        jobId: "job-1",
        apiKeyId: 123,
      },
      featureId: "SEARCH_CREDITS",
    });
  });

  it("refunds Autumn when queueing fails after request tracking", async () => {
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 3,
      properties: {
        source: "billTeam",
        endpoint: "search",
        jobId: "job-1",
        apiKeyId: 123,
      },
      featureId: "SEARCH_CREDITS",
    });
  });

  it("leaves batch tracking enabled when request tracking is off", async () => {
    trackCredits.mockResolvedValueOnce(false);

    await billTeam("team-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      false,
    ]);
    expect(refundCredits).not.toHaveBeenCalled();
  });
});
