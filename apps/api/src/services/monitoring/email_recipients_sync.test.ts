const {
  mockEnsureRecipient,
  mockListRecipients,
  mockGetTeamMemberEmails,
  mockSendConfirmationEmail,
} = vi.hoisted(() => ({
  mockEnsureRecipient: vi.fn(),
  mockListRecipients: vi.fn(),
  mockGetTeamMemberEmails: vi.fn(),
  mockSendConfirmationEmail: vi.fn(),
}));

vi.mock("./email_recipients", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./email_recipients")>();
  return {
    ...actual,
    ensureMonitorEmailRecipient: (...args: unknown[]) =>
      mockEnsureRecipient(...args),
    listMonitorEmailRecipients: (...args: unknown[]) =>
      mockListRecipients(...args),
    getTeamMemberEmails: (...args: unknown[]) =>
      mockGetTeamMemberEmails(...args),
  };
});

vi.mock("../notification/monitoring_email", () => ({
  sendMonitoringConfirmationEmail: (...args: unknown[]) =>
    mockSendConfirmationEmail(...args),
}));

import { syncMonitorEmailRecipients } from "./email_recipients_sync";

beforeEach(() => {
  mockEnsureRecipient.mockReset();
  mockListRecipients.mockReset();
  mockGetTeamMemberEmails.mockReset();
  mockSendConfirmationEmail.mockReset();
  mockSendConfirmationEmail.mockResolvedValue({
    attempted: true,
    success: true,
  });
});

function recipientRow(
  email: string,
  status: "pending" | "confirmed" | "unsubscribed",
  source: "team" | "opt_in" | "legacy",
) {
  return {
    id: `rec-${email}`,
    monitor_id: "monitor-1",
    team_id: "team-1",
    email,
    status,
    token: `tok-${email}`,
    source,
    confirmation_sent_at:
      status === "pending" ? new Date().toISOString() : null,
    confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
    unsubscribed_at:
      status === "unsubscribed" ? new Date().toISOString() : null,
    last_notified_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function monitor(recipients: string[]): any {
  return {
    id: "monitor-1",
    team_id: "team-1",
    name: "Test monitor",
    notification: {
      email: { enabled: true, recipients },
    },
  };
}

describe("syncMonitorEmailRecipients", () => {
  it("returns nothing when there are no configured recipients", async () => {
    const result = await syncMonitorEmailRecipients({
      monitor: monitor([]),
    });
    expect(result.recipients).toEqual([]);
    expect(mockEnsureRecipient).not.toHaveBeenCalled();
  });

  it("auto-confirms team members without sending confirmation email", async () => {
    mockListRecipients.mockResolvedValue([]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set(["owner@team.com"]));
    mockEnsureRecipient.mockImplementation(async ({ input }) => ({
      row: recipientRow(input.email, "confirmed", "team"),
      created: true,
    }));

    const result = await syncMonitorEmailRecipients({
      monitor: monitor(["owner@team.com"]),
    });

    expect(mockEnsureRecipient).toHaveBeenCalledWith({
      monitorId: "monitor-1",
      teamId: "team-1",
      input: { email: "owner@team.com", source: "team", status: "confirmed" },
    });
    expect(mockSendConfirmationEmail).not.toHaveBeenCalled();
    expect(result.recipients[0]).toMatchObject({
      email: "owner@team.com",
      status: "confirmed",
      source: "team",
      created: true,
    });
  });

  it("sends a confirmation email to brand new external recipients", async () => {
    mockListRecipients.mockResolvedValue([]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set());
    mockEnsureRecipient.mockImplementation(async ({ input }) => ({
      row: recipientRow(input.email, "pending", "opt_in"),
      created: true,
    }));

    const result = await syncMonitorEmailRecipients({
      monitor: monitor(["random@elsewhere.com"]),
    });

    expect(mockEnsureRecipient).toHaveBeenCalledWith({
      monitorId: "monitor-1",
      teamId: "team-1",
      input: {
        email: "random@elsewhere.com",
        source: "opt_in",
        status: "pending",
      },
    });
    expect(mockSendConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(result.recipients[0]).toMatchObject({
      email: "random@elsewhere.com",
      status: "pending",
      source: "opt_in",
      confirmationEmailSent: true,
      created: true,
    });
  });

  it("does not re-send a confirmation email for an existing pending recipient", async () => {
    mockListRecipients.mockResolvedValue([
      recipientRow("waiting@elsewhere.com", "pending", "opt_in"),
    ]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set());

    const result = await syncMonitorEmailRecipients({
      monitor: monitor(["waiting@elsewhere.com"]),
    });

    expect(mockEnsureRecipient).not.toHaveBeenCalled();
    expect(mockSendConfirmationEmail).not.toHaveBeenCalled();
    expect(result.recipients[0]).toMatchObject({
      email: "waiting@elsewhere.com",
      status: "pending",
      created: false,
    });
  });

  it("preserves prior unsubscribe when the same email is re-added later", async () => {
    mockListRecipients.mockResolvedValue([
      recipientRow("ghost@elsewhere.com", "unsubscribed", "opt_in"),
    ]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set());

    const result = await syncMonitorEmailRecipients({
      monitor: monitor(["ghost@elsewhere.com"]),
    });

    expect(mockEnsureRecipient).not.toHaveBeenCalled();
    expect(mockSendConfirmationEmail).not.toHaveBeenCalled();
    expect(result.recipients[0]).toMatchObject({
      email: "ghost@elsewhere.com",
      status: "unsubscribed",
    });
  });

  it("normalizes emails (lowercases, trims, dedupes) before reconciling", async () => {
    mockListRecipients.mockResolvedValue([]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set(["dup@example.com"]));
    mockEnsureRecipient.mockImplementation(async ({ input }) => ({
      row: recipientRow(input.email, "confirmed", "team"),
      created: true,
    }));

    const result = await syncMonitorEmailRecipients({
      monitor: monitor([
        "Dup@Example.com",
        "  dup@example.com  ",
        "dup@EXAMPLE.com",
      ]),
    });

    expect(mockEnsureRecipient).toHaveBeenCalledTimes(1);
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].email).toBe("dup@example.com");
  });

  it("handles a mix of team members and externals in one sync", async () => {
    mockListRecipients.mockResolvedValue([]);
    mockGetTeamMemberEmails.mockResolvedValue(new Set(["owner@team.com"]));
    mockEnsureRecipient.mockImplementation(async ({ input }) => ({
      row: recipientRow(input.email, input.status, input.source),
      created: true,
    }));

    const result = await syncMonitorEmailRecipients({
      monitor: monitor(["owner@team.com", "external@elsewhere.com"]),
    });

    expect(mockSendConfirmationEmail).toHaveBeenCalledTimes(1);
    const emailedTo =
      mockSendConfirmationEmail.mock.calls[0][0].recipient.email;
    expect(emailedTo).toBe("external@elsewhere.com");

    const byEmail = new Map(result.recipients.map(r => [r.email, r]));
    expect(byEmail.get("owner@team.com")?.status).toBe("confirmed");
    expect(byEmail.get("external@elsewhere.com")?.status).toBe("pending");
  });
});
