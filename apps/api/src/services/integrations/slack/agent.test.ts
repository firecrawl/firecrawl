import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted, so the mocks its factories reference are hoisted too.
const mocks = vi.hoisted(() => ({
  postSlackMessage: vi.fn(),
  updateSlackMessage: vi.fn(),
  launchAgentJob: vi.fn(),
  getExtractV3AgentStatus: vi.fn(),
  getACUCTeam: vi.fn(),
  getAgentFreeRequestsLeft: vi.fn(),
  checkCredits: vi.fn(),
  consume: vi.fn(),
  redisSet: vi.fn(),
  apiKeyRows: [] as unknown[],
}));

vi.mock("./client", () => ({
  postSlackMessage: mocks.postSlackMessage,
  updateSlackMessage: mocks.updateSlackMessage,
}));
vi.mock("./crypto", () => ({
  decryptSlackToken: () => "bot-token-placeholder",
}));
vi.mock("../../../lib/agent-launch", () => ({
  launchAgentJob: mocks.launchAgentJob,
}));
vi.mock("../../../lib/extract-v3-status", () => ({
  getExtractV3AgentStatus: mocks.getExtractV3AgentStatus,
}));
vi.mock("../../../controllers/auth", () => ({
  getACUCTeam: mocks.getACUCTeam,
}));
vi.mock("../../../db/rpc", () => ({
  getAgentFreeRequestsLeft: mocks.getAgentFreeRequestsLeft,
}));
vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: mocks.checkCredits,
    getRateLimitMultiplier: async () => 1,
  },
}));
vi.mock("../../rate-limiter", () => ({
  getAutumnRateLimiter: () => ({ consume: mocks.consume }),
}));
vi.mock("../../redis", () => ({
  redisEvictConnection: { set: mocks.redisSet },
}));
vi.mock("../../../db/connection", () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => mocks.apiKeyRows,
  };
  return { db: chain, dbRr: chain };
});

import { config } from "../../../config";
import {
  buildAgentAnswerText,
  handleSlackAgentEvent,
  markdownToSlackMrkdwn,
  parseSlackAgentEvent,
  slackTextToPrompt,
  truncateSlackText,
} from "./agent";
import { slackOAuthScopes } from "./oauth";
import type { SlackInstallationRow } from "./types";

const BOT = "UBOT123";
const INSTALL = { bot_user_id: BOT, slack_team_id: "T1" };

describe("slack agent scopes", () => {
  const ORIGINAL_FLAG = config.SLACK_AGENT_ENABLED;
  afterEach(() => {
    config.SLACK_AGENT_ENABLED = ORIGINAL_FLAG;
  });

  it("requests the mention and DM scopes only when the flag is on", () => {
    config.SLACK_AGENT_ENABLED = false;
    expect(slackOAuthScopes()).toBe(config.SLACK_OAUTH_SCOPES);
    config.SLACK_AGENT_ENABLED = true;
    expect(slackOAuthScopes().split(",")).toEqual(
      expect.arrayContaining(["chat:write", "app_mentions:read", "im:history"]),
    );
  });
});

describe("slack agent event parsing", () => {
  it("answers a channel mention in a new thread under the message", () => {
    expect(
      parseSlackAgentEvent(
        {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "100.1",
          text: `<@${BOT}> what is firecrawl?`,
        },
        INSTALL,
      ),
    ).toEqual({
      channel: "C1",
      threadTs: "100.1",
      userId: "U1",
      prompt: "what is firecrawl?",
    });
  });

  it("keeps the existing thread for a mention inside a thread", () => {
    const parsed = parseSlackAgentEvent(
      {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "100.2",
        thread_ts: "100.1",
        text: `<@${BOT}> and pricing?`,
      },
      INSTALL,
    );
    expect(parsed?.threadTs).toBe("100.1");
  });

  it("replies top-level to a top-level DM", () => {
    const parsed = parseSlackAgentEvent(
      {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        ts: "100.1",
        text: "summarize example.com",
      },
      INSTALL,
    );
    expect(parsed).toMatchObject({
      channel: "D1",
      prompt: "summarize example.com",
    });
    expect(parsed?.threadTs).toBeUndefined();
  });

  it("skips bot messages, subtypes, our own bot and empty prompts", () => {
    const base = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      ts: "1",
      text: "hi",
    };
    expect(parseSlackAgentEvent({ ...base, bot_id: "B1" }, INSTALL)).toBeNull();
    expect(
      parseSlackAgentEvent({ ...base, subtype: "message_changed" }, INSTALL),
    ).toBeNull();
    expect(parseSlackAgentEvent({ ...base, user: BOT }, INSTALL)).toBeNull();
    // Shared-channel sender from another workspace.
    expect(
      parseSlackAgentEvent({ ...base, user_team: "T_OTHER" }, INSTALL),
    ).toBeNull();
    expect(
      parseSlackAgentEvent({ ...base, user_team: "T1" }, INSTALL),
    ).not.toBeNull();
    expect(
      parseSlackAgentEvent(
        {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "1",
          text: `<@${BOT}>`,
        },
        INSTALL,
      ),
    ).toBeNull();
  });

  it("skips channel messages and mentions inside the bot's DM", () => {
    expect(
      parseSlackAgentEvent(
        {
          type: "message",
          channel_type: "channel",
          channel: "C1",
          user: "U1",
          ts: "1",
          text: "hi",
        },
        INSTALL,
      ),
    ).toBeNull();
    expect(
      parseSlackAgentEvent(
        {
          type: "app_mention",
          channel: "D1",
          user: "U1",
          ts: "1",
          text: `<@${BOT}> hi`,
        },
        INSTALL,
      ),
    ).toBeNull();
  });

  it("turns Slack-encoded text into a plain prompt", () => {
    expect(
      slackTextToPrompt(
        `<@${BOT}|firecrawl> compare <https://a.com|a.com> &amp; <https://b.com> in <#C1|general> &lt;now&gt;`,
        BOT,
      ),
    ).toBe("compare https://a.com & https://b.com in #general <now>");
  });
});

describe("slack agent answer formatting", () => {
  it("converts markdown to Slack mrkdwn and leaves code blocks alone", () => {
    const out = markdownToSlackMrkdwn(
      "# Title\n**bold** and [docs](https://docs.example.com/a|b)\n- item\n```\n**raw** <tag>\n```",
    );
    expect(out).toContain("*Title*");
    expect(out).toContain("*bold*");
    expect(out).toContain("<https://docs.example.com/a%7Cb|docs>");
    expect(out).toContain("• item");
    expect(out).toContain("```\n**raw** &lt;tag&gt;\n```");
  });

  it("truncates at a line break and closes an open code block", () => {
    const text = "intro\n```\n" + "line\n".repeat(200) + "```";
    const out = truncateSlackText(text, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    expect(truncateSlackText("short", 300)).toBe("short");
  });

  it("prefers the chat message and lists sources within the limit", () => {
    const out = buildAgentAnswerText({
      message: "a".repeat(10_000),
      data: {
        sources: [
          "https://example.com/1",
          { url: "https://example.com/2" },
          "ftp://x",
        ],
      },
    });
    expect(out.length).toBeLessThanOrEqual(3_900);
    expect(out).toContain(
      "*Sources*\n• <https://example.com/1>\n• <https://example.com/2>",
    );
    expect(out).not.toContain("ftp://");
  });

  it("falls back to the data as JSON", () => {
    expect(buildAgentAnswerText({ data: { price: 5 } })).toContain(
      '"price": 5',
    );
  });
});

describe("handleSlackAgentEvent", () => {
  const installation = {
    team_id: "team-1",
    slack_team_id: "T1",
    bot_user_id: BOT,
    bot_token: "stored-token",
  } as SlackInstallationRow;
  const event = {
    type: "app_mention",
    channel: "C1",
    user: "U1",
    ts: "100.1",
    text: `<@${BOT}> what changed on example.com?`,
  };
  const ORIGINAL_BETA_URL = config.EXTRACT_V3_BETA_URL;
  const ORIGINAL_DB_AUTH = config.USE_DB_AUTHENTICATION;

  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
    }
    config.EXTRACT_V3_BETA_URL = "http://agent.internal.test";
    config.USE_DB_AUTHENTICATION = true;
    mocks.apiKeyRows = [{ key: "11111111-1111-1111-1111-111111111111", id: 7 }];
    mocks.redisSet.mockResolvedValue("OK");
    mocks.postSlackMessage.mockResolvedValue({ ok: true, ts: "200.1" });
    mocks.updateSlackMessage.mockResolvedValue({ ok: true });
    mocks.getACUCTeam.mockResolvedValue({ org_id: "org-1", flags: null });
    mocks.consume.mockResolvedValue({});
    mocks.getAgentFreeRequestsLeft.mockResolvedValue([
      { free_requests_left: 0 },
    ]);
    mocks.checkCredits.mockResolvedValue({ allowed: true, remaining: 1000 });
    mocks.launchAgentJob.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    config.EXTRACT_V3_BETA_URL = ORIGINAL_BETA_URL;
    config.USE_DB_AUTHENTICATION = ORIGINAL_DB_AUTH;
  });

  const run = () =>
    handleSlackAgentEvent({
      installation,
      eventId: "Ev1",
      event,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
    });

  it("posts a placeholder, runs the agent for the team and posts the answer", async () => {
    mocks.getExtractV3AgentStatus
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({
        status: "success",
        message: "**Pricing** changed.",
      });

    await run();

    expect(mocks.postSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", threadTs: "100.1" }),
    );
    const launch = mocks.launchAgentJob.mock.calls[0][0];
    expect(launch).toMatchObject({
      teamId: "team-1",
      apiKey: "11111111-1111-1111-1111-111111111111",
      apiKeyId: 7,
      request: {
        prompt: "what changed on example.com?",
        origin: "slack",
        mode: "chat",
      },
    });
    expect(mocks.checkCredits).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", orgId: "org-1", value: 20 }),
    );
    expect(mocks.updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "200.1",
        text: "*Pricing* changed.",
      }),
    );
  });

  it("does nothing for an event it already handled", async () => {
    mocks.redisSet.mockResolvedValue(null);
    await run();
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
    expect(mocks.launchAgentJob).not.toHaveBeenCalled();
  });

  it("replaces the placeholder with a credits error and starts no run", async () => {
    mocks.checkCredits.mockResolvedValue({ allowed: false, remaining: 3 });
    await run();
    expect(mocks.launchAgentJob).not.toHaveBeenCalled();
    expect(mocks.updateSlackMessage.mock.calls[0][0].text).toContain(
      "enough credits",
    );
  });

  it("reports a failed run without leaking its error", async () => {
    mocks.getExtractV3AgentStatus.mockResolvedValue({
      status: "failed",
      error: "internal stack trace",
    });
    await run();
    const text = mocks.updateSlackMessage.mock.calls[0][0].text;
    expect(text).toContain("Something went wrong");
    expect(text).not.toContain("stack trace");
  });

  it("reports a timeout when the run does not finish in time", async () => {
    mocks.getExtractV3AgentStatus.mockResolvedValue({ status: "processing" });
    await handleSlackAgentEvent({
      installation,
      event,
      timeoutMs: 20,
      pollIntervalMs: 5,
    });
    expect(mocks.updateSlackMessage.mock.calls[0][0].text).toContain(
      "taking longer than expected",
    );
  });
});
