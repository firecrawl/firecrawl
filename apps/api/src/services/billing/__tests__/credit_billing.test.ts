import { jest } from "@jest/globals";

const withAuth = jest.fn((fn: any) => fn);
jest.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

const queueBillingOperation = jest.fn<(args: any[]) => Promise<any>>();
jest.mock("../batch_billing", () => ({
  queueBillingOperation: (...args: any[]) => queueBillingOperation(args),
}));

jest.mock("../../notification/email_notification", () => ({
  sendNotification: jest.fn(),
}));
jest.mock("../../supabase", () => ({
  supabase_rr_service: {},
  supabase_service: {},
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
});

describe("billTeam", () => {
  it("queues a billing operation with the correct arguments", async () => {
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
    ]);
  });

  it("passes is_extract=false by default", async () => {
    await billTeam("team-1", "sub-1", 5, null, {
      endpoint: "scrape",
      jobId: "job-2",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "sub-1",
      5,
      null,
      { endpoint: "scrape", jobId: "job-2" },
      false,
    ]);
  });
});
