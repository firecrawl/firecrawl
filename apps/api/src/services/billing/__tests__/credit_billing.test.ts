import { jest } from "@jest/globals";

const withAuth = jest.fn((fn: any) => fn);
jest.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

const queueBillingOperation = jest.fn<(args: any[]) => Promise<any>>();
jest.mock("../batch_billing", () => ({
  queueBillingOperation: (...args: any[]) => queueBillingOperation(args),
}));

const trackCredits = jest.fn<(args: any) => Promise<boolean>>();
const refundCredits = jest.fn<(args: any) => Promise<void>>();
jest.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
  },
}));

jest.mock("../../notification/email_notification", () => ({
  sendNotification: jest.fn(),
}));
jest.mock("../auto_charge", () => ({
  autoCharge: jest.fn(),
}));
jest.mock("../../redis", () => ({
  getValue: jest.fn(),
  setValue: jest.fn(),
}));
jest.mock("../../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { billTeam } from "../credit_billing";

beforeEach(() => {
  jest.clearAllMocks();
  queueBillingOperation.mockResolvedValue({ success: true });
  trackCredits.mockResolvedValue(true);
  refundCredits.mockResolvedValue(undefined);
});

describe("billTeam", () => {
  it("marks billing as already tracked when request tracking succeeds", async () => {
    await billTeam("team-1", "sub-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "sub-1",
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
      requestScoped: true,
    });
  });

  it("refunds Autumn when queueing fails after request tracking", async () => {
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", "sub-1", 3, 123, {
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
    });
  });

  it("leaves batch tracking enabled when request tracking is off", async () => {
    trackCredits.mockResolvedValueOnce(false);

    await billTeam("team-1", "sub-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "sub-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      false,
    ]);
    expect(refundCredits).not.toHaveBeenCalled();
  });
});
