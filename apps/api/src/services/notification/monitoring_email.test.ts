const {
  mockEnsureRecipient,
  mockListRecipients,
  mockTouchNotified,
  mockMarkConfirmationSent,
  mockResendSend,
} = vi.hoisted(() => ({
  mockEnsureRecipient: vi.fn(),
  mockListRecipients: vi.fn(),
  mockTouchNotified: vi.fn(),
  mockMarkConfirmationSent: vi.fn(),
  mockResendSend: vi.fn(),
}));

vi.mock("../monitoring/email_recipients", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../monitoring/email_recipients")>();
  return {
    ...actual,
    ensureMonitorEmailRecipient: (...args: unknown[]) =>
      mockEnsureRecipient(...args),
    listMonitorEmailRecipients: (...args: unknown[]) =>
      mockListRecipients(...args),
    touchRecipientsNotified: (...args: unknown[]) => mockTouchNotified(...args),
    markRecipientConfirmationSent: (...args: unknown[]) =>
      mockMarkConfirmationSent(...args),
  };
});

vi.mock("resend", () => ({
  // Regular function (not arrow) so it works as a constructor under `new Resend()`.
  Resend: vi.fn(function () {
    return { emails: { send: mockResendSend } };
  }),
}));

import {
  buildConfirmationHtml,
  buildHtml,
  buildMonitoringCheckDashboardUrl,
  buildRecipientConfirmationUrl,
  buildRecipientUnsubscribeUrl,
  sendMonitoringConfirmationEmail,
  sendMonitoringEmailSummary,
  type MonitoringEmailPayload,
} from "./monitoring_email";
import { config } from "../../config";

const ORIGINAL_RESEND_API_KEY = config.RESEND_API_KEY;

beforeEach(() => {
  mockEnsureRecipient.mockReset();
  mockListRecipients.mockReset();
  mockTouchNotified.mockReset();
  mockMarkConfirmationSent.mockReset();
  mockResendSend.mockReset();
  mockResendSend.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  mockTouchNotified.mockResolvedValue(undefined);
  mockMarkConfirmationSent.mockResolvedValue(undefined);
  // getResendClient() reads config.RESEND_API_KEY (a snapshot of process.env at
  // import time), so set it on the config object directly to make the suite
  // hermetic regardless of the runner's environment.
  config.RESEND_API_KEY = "test-key";
});

afterAll(() => {
  config.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
});

function fakeRecipient(
  email: string,
  status: "pending" | "confirmed" | "unsubscribed",
  source: "team" | "opt_in" | "legacy" = "opt_in",
) {
  const sanitized = email.replace(/[^a-z0-9]/gi, "");
  return {
    id: `rec-${sanitized}`,
    monitor_id: "monitor-1",
    team_id: "team-1",
    email,
    status,
    token: `tok-${sanitized}`,
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

describe("monitoring email URLs", () => {
  it("builds a dashboard link for a monitor check", () => {
    expect(
      buildMonitoringCheckDashboardUrl(
        {
          monitorId: "019e07fb-fb25-74cb-9a6c-f36c685c6e5b",
          checkId: "019e0903-bf7c-779f-a8a5-736ba82d3974",
        },
        "https://firecrawl-o2cg7p09w-side-guide.vercel.app/",
      ),
    ).toBe(
      "https://firecrawl-o2cg7p09w-side-guide.vercel.app/app/monitoring/019e07fb-fb25-74cb-9a6c-f36c685c6e5b?checkId=019e0903-bf7c-779f-a8a5-736ba82d3974",
    );
  });

  it("builds opt-in and unsubscribe URLs against the dashboard base", () => {
    const confirm = buildRecipientConfirmationUrl("abc123");
    expect(confirm).toContain("/monitoring/email/confirm");
    expect(confirm).not.toContain("/v2/");
    expect(confirm).toContain("token=abc123");

    const unsub = buildRecipientUnsubscribeUrl("abc123");
    expect(unsub).toContain("/monitoring/email/unsubscribe");
    expect(unsub).not.toContain("/v2/");
    expect(unsub).toContain("token=abc123");
  });

  it("includes the dashboard check link and unsubscribe footer in the email html", () => {
    const dashboardUrl = buildMonitoringCheckDashboardUrl(
      {
        monitorId: "monitor-1",
        checkId: "check-1",
      },
      "https://www.firecrawl.dev",
    );
    const payload: MonitoringEmailPayload = {
      monitorId: "monitor-1",
      monitorName: "Docs monitor",
      checkId: "check-1",
      dashboardUrl,
      summary: {
        changed: 1,
        new: 0,
        removed: 0,
        error: 0,
        totalPages: 1,
      },
      pages: [
        {
          url: "https://example.com/docs",
          status: "changed",
        },
      ],
      creditsUsed: 1,
      unsubscribeUrl:
        "https://www.firecrawl.dev/monitoring/email/unsubscribe?token=tok123",
    };

    const html = buildHtml(payload);
    expect(html).toContain(
      `<a href="${dashboardUrl}">View this check in the dashboard</a>`,
    );
    expect(html).toContain(
      "https://www.firecrawl.dev/monitoring/email/unsubscribe?token=tok123",
    );
    expect(html).toContain("Unsubscribe from this monitor");
  });

  it("omits the unsubscribe footer when no unsubscribe URL is provided", () => {
    const html = buildHtml({
      monitorId: "m1",
      monitorName: "M",
      checkId: "c1",
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      summary: { changed: 0, new: 1, removed: 0, error: 0, totalPages: 1 },
      pages: [{ url: "https://example.com", status: "new" }],
      creditsUsed: 1,
    });
    expect(html).not.toContain("Unsubscribe from this monitor");
  });
});

describe("buildConfirmationHtml", () => {
  it("renders a confirm CTA and a fallback unsubscribe link", () => {
    const html = buildConfirmationHtml({
      monitorName: "Marketing site",
      recipientEmail: "alerts@example.com",
      confirmUrl:
        "https://www.firecrawl.dev/monitoring/email/confirm?token=tok1",
      unsubscribeUrl:
        "https://www.firecrawl.dev/monitoring/email/unsubscribe?token=tok1",
    });
    expect(html).toContain("Confirm subscription");
    expect(html).toContain("Marketing site");
    expect(html).toContain("alerts@example.com");
    expect(html).toContain("token=tok1");
  });

  it("escapes HTML in recipient and monitor names", () => {
    const html = buildConfirmationHtml({
      monitorName: "<script>x</script>",
      recipientEmail: "a@b.com",
      confirmUrl: "https://example.com/c?token=t",
      unsubscribeUrl: "https://example.com/u?token=t",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sendMonitoringConfirmationEmail", () => {
  it("sends a Resend email and marks confirmation_sent_at", async () => {
    const result = await sendMonitoringConfirmationEmail({
      recipient: fakeRecipient("new@example.com", "pending"),
      monitorName: "My monitor",
    });
    expect(result).toEqual({ attempted: true, success: true });
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend.mock.calls[0][0].to).toBe("new@example.com");
    expect(mockResendSend.mock.calls[0][0].subject).toContain(
      "Confirm subscription",
    );
    expect(mockMarkConfirmationSent).toHaveBeenCalledWith("rec-newexamplecom");
  });

  it("returns failure if Resend reports an error", async () => {
    mockResendSend.mockResolvedValueOnce({ data: null, error: "boom" });
    const result = await sendMonitoringConfirmationEmail({
      recipient: fakeRecipient("new@example.com", "pending"),
      monitorName: "My monitor",
    });
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(mockMarkConfirmationSent).not.toHaveBeenCalled();
  });
});

describe("sendMonitoringEmailSummary", () => {
  function buildArgs(opts: {
    goal?: string | null;
    emailEnabled?: boolean;
    recipients?: string[];
    pages: Array<{
      status: string;
      meaningful?: boolean | null;
    }>;
  }) {
    return {
      monitor: {
        id: "monitor-1",
        team_id: "team-1",
        name: "Test",
        goal: opts.goal ?? null,
        judge_enabled: Boolean(opts.goal),
        notification: opts.emailEnabled
          ? {
              email: {
                enabled: true,
                recipients: opts.recipients ?? ["a@b.com"],
              },
            }
          : null,
      } as any,
      check: {
        id: "check-1",
        changed_count: opts.pages.filter(p => p.status === "changed").length,
        new_count: opts.pages.filter(p => p.status === "new").length,
        removed_count: opts.pages.filter(p => p.status === "removed").length,
        error_count: opts.pages.filter(p => p.status === "error").length,
      } as any,
      pages: opts.pages.map((p, i) => ({
        url: `https://example.com/${i}`,
        status: p.status,
        judgment:
          p.meaningful === null || p.meaningful === undefined
            ? null
            : {
                meaningful: p.meaningful,
                confidence: "high" as const,
                reason: "test",
                fields: [],
              },
      })),
    };
  }

  describe("judgment gating", () => {
    beforeEach(() => {
      mockListRecipients.mockResolvedValue([
        fakeRecipient("a@b.com", "confirmed"),
      ]);
    });

    it("suppresses email when goal set and all changed pages are noise", async () => {
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          goal: "track price changes",
          emailEnabled: true,
          pages: [
            { status: "changed", meaningful: false },
            { status: "changed", meaningful: false },
          ],
        }),
      );
      expect(result.attempted).toBe(false);
    });

    it("fires email when goal set and at least one changed page is meaningful", async () => {
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          goal: "track price changes",
          emailEnabled: true,
          pages: [
            { status: "changed", meaningful: false },
            { status: "changed", meaningful: true },
          ],
        }),
      );
      expect(result.attempted).toBe(true);
    });

    it("fires email when goal set and changed page has no judgment (judge errored)", async () => {
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          goal: "track price changes",
          emailEnabled: true,
          pages: [{ status: "changed", meaningful: null }],
        }),
      );
      expect(result.attempted).toBe(true);
    });

    it("fires email when goal set but page status is new/removed (always meaningful)", async () => {
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          goal: "track anything",
          emailEnabled: true,
          pages: [{ status: "changed", meaningful: false }, { status: "new" }],
        }),
      );
      expect(result.attempted).toBe(true);
    });

    it("backwards compat: no goal → fires email on any change (no gating)", async () => {
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          goal: null,
          emailEnabled: true,
          pages: [{ status: "changed", meaningful: false }],
        }),
      );
      expect(result.attempted).toBe(true);
    });

    it("fails open when changed-page list is truncated (would otherwise suppress)", async () => {
      const args = buildArgs({
        goal: "track price changes",
        emailEnabled: true,
        pages: [
          { status: "changed", meaningful: false },
          { status: "changed", meaningful: false },
        ],
      });
      (args.check as any).changed_count = 50;
      const result = await sendMonitoringEmailSummary(args);
      expect(result.attempted).toBe(true);
    });

    it("fails open when counters report new/error pages beyond the truncated list", async () => {
      const args = buildArgs({
        goal: "track price changes",
        emailEnabled: true,
        pages: [
          { status: "changed", meaningful: false },
          { status: "changed", meaningful: false },
        ],
      });
      // The visible page list is all noise, but the check aggregates report new
      // pages that fell outside the 100-page window — the email must still fire.
      (args.check as any).new_count = 5;
      const result = await sendMonitoringEmailSummary(args);
      expect(result.attempted).toBe(true);
    });
  });

  describe("opt-in gating", () => {
    it("skips entirely when no recipients have confirmed", async () => {
      mockListRecipients.mockResolvedValue([
        fakeRecipient("a@b.com", "pending"),
      ]);
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          emailEnabled: true,
          recipients: ["a@b.com"],
          pages: [{ status: "changed" }],
        }),
      );
      expect(result.attempted).toBe(false);
      expect(result.recipients).toEqual([]);
      expect(result.pendingRecipients).toBe(1);
      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it("skips unsubscribed recipients but emails confirmed ones", async () => {
      mockListRecipients.mockResolvedValue([
        fakeRecipient("good@example.com", "confirmed"),
        fakeRecipient("blocked@example.com", "unsubscribed"),
      ]);
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          emailEnabled: true,
          recipients: ["good@example.com", "blocked@example.com"],
          pages: [{ status: "changed" }],
        }),
      );
      expect(result.attempted).toBe(true);
      expect(result.recipients).toEqual(["good@example.com"]);
      expect(result.unsubscribedRecipients).toBe(1);
      expect(mockResendSend).toHaveBeenCalledTimes(1);
      expect(mockResendSend.mock.calls[0][0].to).toBe("good@example.com");
    });

    it("sends one email per recipient with a unique unsubscribe link", async () => {
      mockListRecipients.mockResolvedValue([
        fakeRecipient("a@example.com", "confirmed"),
        fakeRecipient("b@example.com", "confirmed"),
      ]);
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          emailEnabled: true,
          recipients: ["a@example.com", "b@example.com"],
          pages: [{ status: "changed" }],
        }),
      );
      expect(result.attempted).toBe(true);
      expect(mockResendSend).toHaveBeenCalledTimes(2);
      const calls = mockResendSend.mock.calls.map(c => c[0]);
      const aCall = calls.find(c => c.to === "a@example.com");
      const bCall = calls.find(c => c.to === "b@example.com");
      expect(aCall.html).toContain("token=tok-aexamplecom");
      expect(bCall.html).toContain("token=tok-bexamplecom");
      expect(aCall.html).not.toContain("token=tok-bexamplecom");
      expect(mockTouchNotified).toHaveBeenCalledWith([
        "rec-aexamplecom",
        "rec-bexamplecom",
      ]);
    });

    it("bootstraps legacy monitors when recipient rows are entirely missing", async () => {
      mockListRecipients.mockResolvedValue([]);
      mockEnsureRecipient.mockResolvedValue({
        created: true,
        row: fakeRecipient("unknown@example.com", "confirmed", "legacy"),
      });

      const result = await sendMonitoringEmailSummary(
        buildArgs({
          emailEnabled: true,
          recipients: ["unknown@example.com"],
          pages: [{ status: "changed" }],
        }),
      );
      expect(result.attempted).toBe(true);
      expect(result.recipients).toEqual(["unknown@example.com"]);
      expect(mockEnsureRecipient).toHaveBeenCalledWith({
        monitorId: "monitor-1",
        teamId: "team-1",
        input: {
          email: "unknown@example.com",
          source: "legacy",
          status: "confirmed",
        },
      });
    });

    it("treats missing recipients as pending when rows are partially present", async () => {
      mockListRecipients.mockResolvedValue([
        fakeRecipient("known@example.com", "confirmed"),
      ]);
      const result = await sendMonitoringEmailSummary(
        buildArgs({
          emailEnabled: true,
          recipients: ["known@example.com", "unknown@example.com"],
          pages: [{ status: "changed" }],
        }),
      );
      expect(result.attempted).toBe(true);
      expect(result.recipients).toEqual(["known@example.com"]);
      expect(result.pendingRecipients).toBe(1);
      expect(mockEnsureRecipient).not.toHaveBeenCalled();
    });
  });
});
