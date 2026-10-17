import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  handleSlackAgentEvent: vi.fn(),
  getSlackInstallationBySlackTeam: vi.fn(),
  deleteSlackInstallationsBySlackTeam: vi.fn(),
}));

vi.mock("../../services/integrations/slack/signature", () => ({
  verifySlackSignature: () => true,
}));
vi.mock("../../services/integrations/slack/agent", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../services/integrations/slack/agent")
  >()),
  handleSlackAgentEvent: mocks.handleSlackAgentEvent,
}));
vi.mock("../../services/integrations/slack/store", () => ({
  getSlackInstallationBySlackTeam: mocks.getSlackInstallationBySlackTeam,
  deleteSlackInstallationsBySlackTeam:
    mocks.deleteSlackInstallationsBySlackTeam,
  deleteSlackInstallationByTeam: vi.fn(),
  getSlackInstallationByTeam: vi.fn(),
}));
vi.mock("../../services/integrations/slack/commands", () => ({
  handleFirecrawlCommand: vi.fn(),
  handleSlashCommand: vi.fn(),
}));

import { config } from "../../config";
import { slackEventsController } from "./slack";

const ORIGINAL_FLAG = config.SLACK_AGENT_ENABLED;

function call(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const req = {
    body,
    headers,
    rawBody: Buffer.from("{}"),
  } as unknown as Request;
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send: vi.fn(),
    json: vi.fn(),
  };
  return {
    res,
    done: slackEventsController(req, res as unknown as Response),
  };
}

const mentionBody = {
  type: "event_callback",
  team_id: "T1",
  event_id: "Ev1",
  event: {
    type: "app_mention",
    channel: "C1",
    user: "U1",
    ts: "1",
    text: "<@UBOT> hi",
  },
};

beforeEach(() => {
  mocks.handleSlackAgentEvent.mockReset().mockResolvedValue(undefined);
  mocks.getSlackInstallationBySlackTeam
    .mockReset()
    .mockResolvedValue({ team_id: "team-1", bot_user_id: "UBOT" });
  mocks.deleteSlackInstallationsBySlackTeam
    .mockReset()
    .mockResolvedValue(undefined);
  config.SLACK_AGENT_ENABLED = true;
});

afterEach(() => {
  config.SLACK_AGENT_ENABLED = ORIGINAL_FLAG;
});

describe("slackEventsController agent events", () => {
  it("acks at once and hands the mention to the agent handler", async () => {
    const { res, done } = call(mentionBody);
    await done;
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(mocks.handleSlackAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "Ev1",
          installation: expect.objectContaining({ team_id: "team-1" }),
        }),
      ),
    );
  });

  it("ignores Slack retries", async () => {
    const { res, done } = call(mentionBody, { "x-slack-retry-num": "1" });
    await done;
    expect(res.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    expect(mocks.getSlackInstallationBySlackTeam).not.toHaveBeenCalled();
    expect(mocks.handleSlackAgentEvent).not.toHaveBeenCalled();
  });

  it("does nothing with mentions when the flag is off", async () => {
    config.SLACK_AGENT_ENABLED = false;
    const { res, done } = call(mentionBody);
    await done;
    expect(res.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    expect(mocks.handleSlackAgentEvent).not.toHaveBeenCalled();
  });

  it("still cleans up on app_uninstalled", async () => {
    const { done } = call({
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_uninstalled" },
    });
    await done;
    expect(mocks.deleteSlackInstallationsBySlackTeam).toHaveBeenCalledWith(
      "T1",
    );
    expect(mocks.handleSlackAgentEvent).not.toHaveBeenCalled();
  });
});
