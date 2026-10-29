import { vi } from "vitest";

// vi.mock is hoisted; factory-referenced values must be created in vi.hoisted().
const {
  withAuth,
  queueBillingOperation,
  trackCredits,
  refundCredits,
  isRoutedThroughFirebill,
  trackHostedMcpCredits,
  refundHostedMcpCredits,
} = vi.hoisted(() => ({
  withAuth: vi.fn((fn: any) => fn),
  queueBillingOperation: vi.fn<(args: any[]) => Promise<any>>(),
  trackCredits: vi.fn<(args: any) => Promise<boolean>>(),
  refundCredits: vi.fn<(args: any) => Promise<void>>(),
  isRoutedThroughFirebill:
    vi.fn<(teamId: string, orgId: string) => Promise<boolean>>(),
  trackHostedMcpCredits:
    vi.fn<(args: any) => Promise<{ tracked: boolean; mcpCredits: number }>>(),
  refundHostedMcpCredits: vi.fn<(args: any) => Promise<boolean>>(),
}));
const { recordRequestCredits } = vi.hoisted(() => ({
  recordRequestCredits: vi.fn<(args: any) => Promise<boolean>>(),
}));

vi.mock("../../../lib/request-credits-store", () => ({
  recordRequestCredits,
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
    trackHostedMcpCredits,
    refundHostedMcpCredits,
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
  trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 0 });
  recordRequestCredits.mockResolvedValue(true);
});

describe("billTeam", () => {
  it("carries the caller's external request id on the charge, and omits it without one", async () => {
    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "scrape",
      jobId: "job-9",
      chargeId: "job-9",
      externalRequestId: "partner-op-42",
    });
    expect(trackCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalRequestId: "partner-op-42" }),
    );

    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "scrape",
      jobId: "job-9",
      externalRequestId: null,
    });
    expect(trackCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalRequestId: undefined }),
    );
  });

  it("derives firebill idempotency keys from chargeId, and omits them without one", async () => {
    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "search",
      jobId: "job-9",
      chargeId: "job-9",
    });
    expect(trackCredits).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: "fc:track:search:job-9" }),
    );

    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "search",
      jobId: "job-9",
    });
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

    await billTeam("team-1", "org-1", 3, 123, {
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

    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "map",
      jobId: "map-1",
      chargeId: "map-1",
      externalRequestId: "partner-op-42",
    });

    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "fc:refund:map:map-1",
        externalRequestId: "partner-op-42",
      }),
    );
  });

  it("marks billing as already tracked when request tracking succeeds", async () => {
    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "org-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      true,
    ]);
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      orgId: "org-1",
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

    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      orgId: "org-1",
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

  // preview/keyless teams have no org, and this is the one boundary that
  // accepts that: the ledger is still enqueued, Autumn is simply not told.
  it("skips Autumn entirely when the team has no org", async () => {
    await billTeam("preview_abc", null, 3, null, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(trackCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queueBillingOperation).toHaveBeenCalledWith([
      "preview_abc",
      null,
      3,
      null,
      { endpoint: "search", jobId: "job-1" },
      false,
      false,
    ]);
  });

  it("leaves batch tracking enabled when request tracking is off", async () => {
    trackCredits.mockResolvedValueOnce(false);

    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "search",
      jobId: "job-1",
    });

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "org-1",
      3,
      123,
      { endpoint: "search", jobId: "job-1" },
      false,
      false,
    ]);
    expect(refundCredits).not.toHaveBeenCalled();
  });
});

describe("billTeam MCP credits", () => {
  const hostedMcpScrape = {
    endpoint: "scrape" as const,
    jobId: "job-1",
    chargeId: "job-1",
    hostedMcp: true,
  };

  it("charges a hosted MCP call through the MCP credits split", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(trackHostedMcpCredits).toHaveBeenCalledExactlyOnceWith({
      teamId: "team-1",
      orgId: "org-1",
      value: 3,
      properties: {
        source: "billTeam",
        endpoint: "scrape",
        jobId: "job-1",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
      idempotencyKey: "fc:track:scrape:job-1",
      externalRequestId: undefined,
    });
    expect(trackCredits).not.toHaveBeenCalled();
    // The ledger records the MCP-paid part apart from regular credits.
    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "org-1",
      3,
      123,
      { ...hostedMcpScrape, mcpCredits: 2 },
      false,
      true,
    ]);
  });

  it("queues an unchanged ledger operation when MCP credits paid nothing", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 0 });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(queueBillingOperation).toHaveBeenCalledWith([
      "team-1",
      "org-1",
      3,
      123,
      hostedMcpScrape,
      false,
      true,
    ]);
  });

  it("refunds a failed enqueue to the balances the charge was tracked on", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(refundHostedMcpCredits).toHaveBeenCalledExactlyOnceWith({
      teamId: "team-1",
      orgId: "org-1",
      value: 3,
      mcpCredits: 2,
      properties: {
        source: "billTeam",
        endpoint: "scrape",
        jobId: "job-1",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
      idempotencyKey: "fc:refund:scrape:job-1",
      externalRequestId: undefined,
    });
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("refunds the MCP credits part of a failed enqueue even when the rest was not tracked", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: false, mcpCredits: 2 });
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(queueBillingOperation).toHaveBeenCalledWith(
      expect.arrayContaining([false]),
    );
    expect(refundHostedMcpCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ value: 2, mcpCredits: 2 }),
    );
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("refunds nothing for a failed enqueue when nothing was tracked", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: false, mcpCredits: 0 });
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(refundHostedMcpCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("refunds a failed enqueue MCP credits paid nothing of as today", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 0 });
    queueBillingOperation.mockResolvedValueOnce({ success: false });

    await billTeam("team-1", "org-1", 3, 123, hostedMcpScrape);

    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, featureId: "CREDITS" }),
    );
    expect(refundHostedMcpCredits).not.toHaveBeenCalled();
  });

  it("never goes through the MCP credits split for a call the hosted MCP did not make", async () => {
    await billTeam("team-1", "org-1", 3, 123, {
      endpoint: "scrape",
      jobId: "job-1",
    });

    expect(trackHostedMcpCredits).not.toHaveBeenCalled();
    expect(trackCredits).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "CREDITS" }),
    );
  });

  it("never charges Autumn for a team without an org", async () => {
    await billTeam("preview_abc", null, 3, null, hostedMcpScrape);

    expect(trackHostedMcpCredits).not.toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
  });
});

describe("billTeam MCP credits on an agent run", () => {
  const agentCall = {
    endpoint: "search" as const,
    jobId: "job-1",
    chargeId: "charge-1",
    hostedMcp: true,
    agentRequestId: "agent-run",
  };

  it("adds the MCP credits part to the run's MCP tally under the charge", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });

    await billTeam("team-1", "org-1", 3, 123, agentCall);

    expect(recordRequestCredits).toHaveBeenCalledExactlyOnceWith({
      requestId: "agent-run:mcp",
      jobId: "charge-1",
      credits: 2,
    });
  });

  it("tallies nothing when MCP credits paid nothing or the charge was refunded", async () => {
    await billTeam("team-1", "org-1", 3, 123, agentCall);

    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });
    queueBillingOperation.mockResolvedValueOnce({ success: false });
    await billTeam("team-1", "org-1", 3, 123, agentCall);

    expect(recordRequestCredits).not.toHaveBeenCalled();
  });

  it("tallies nothing for a call outside an agent run", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });

    await billTeam("team-1", "org-1", 3, 123, {
      ...agentCall,
      agentRequestId: undefined,
    });

    expect(recordRequestCredits).not.toHaveBeenCalled();
  });

  it("still bills when the tally cannot be written", async () => {
    trackHostedMcpCredits.mockResolvedValue({ tracked: true, mcpCredits: 2 });
    recordRequestCredits.mockRejectedValueOnce(new Error("store down"));

    await expect(
      billTeam("team-1", "org-1", 3, 123, agentCall),
    ).resolves.toMatchObject({ success: true });
  });
});
