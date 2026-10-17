import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import { dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { getAgentFreeRequestsLeft } from "../../../db/rpc";
import { getACUCTeam } from "../../../controllers/auth";
import { agentRequestSchema } from "../../../controllers/v2/types";
import { RateLimiterMode } from "../../../types";
import { getAutumnRateLimiter } from "../../rate-limiter";
import { autumnService } from "../../autumn/autumn.service";
import { orgIdFromAcuc } from "../../../lib/team-org";
import { getScrapeZDR } from "../../../lib/zdr-helpers";
import { launchAgentJob } from "../../../lib/agent-launch";
import { getExtractV3AgentStatus } from "../../../lib/extract-v3-status";
import { redisEvictConnection } from "../../redis";
import { postSlackMessage, updateSlackMessage } from "./client";
import { decryptSlackToken } from "./crypto";
import { escapeSlackText, slackLink } from "./messages";
import type { SlackInstallationRow } from "./types";

const logger = _logger.child({ module: "slack-agent" });

// Same minimum the POST /v2/agent route checks before it starts a run.
const AGENT_MIN_CREDITS = 20;
const POLL_INTERVAL_MS = 5_000;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
// Slack truncates long message text; stay well under its 4,000-char guidance.
const SLACK_TEXT_LIMIT = 3_900;
const MAX_SOURCES = 5;
const EVENT_DEDUPE_TTL_SECONDS = 60 * 60;

const PLACEHOLDER_TEXT = ":hourglass_flowing_sand: Researching…";

type SlackAgentEvent = {
  channel: string;
  // Thread to reply in. Undefined for a top-level DM, so the reply stays
  // top-level too.
  threadTs?: string;
  userId: string;
  prompt: string;
};

type RawSlackEvent = {
  type?: string;
  subtype?: string;
  channel_type?: string;
  channel?: string;
  user?: string;
  // Workspace of the sender; differs from ours in shared (Slack Connect)
  // channels.
  user_team?: string;
  team?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
};

export function isSlackAgentEventType(event: RawSlackEvent | undefined) {
  return (
    event?.type === "app_mention" ||
    (event?.type === "message" && event.channel_type === "im")
  );
}

// Turns Slack-encoded message text into a plain prompt: drops the bot
// mention, unwraps links and channel refs, and decodes the escaped entities.
export function slackTextToPrompt(
  text: string,
  botUserId: string | null,
): string {
  const mention = botUserId
    ? new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g")
    : /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/;
  return text
    .replace(mention, "")
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// Returns the mention or DM to answer, or null for events the bot must skip:
// bot traffic (including its own replies), edits and other subtypes, senders
// from other workspaces, and messages with no text left after the mention is
// removed.
export function parseSlackAgentEvent(
  event: RawSlackEvent | undefined,
  installation: { bot_user_id: string | null; slack_team_id: string },
): SlackAgentEvent | null {
  const botUserId = installation.bot_user_id;
  if (!event || !isSlackAgentEventType(event)) return null;
  if (event.subtype || event.bot_id) return null;
  if (!event.user || !event.channel || !event.ts) return null;
  if (botUserId && event.user === botUserId) return null;
  // Runs bill the linked team, so only its own workspace members may start one.
  const senderTeam = event.user_team ?? event.team;
  if (senderTeam && senderTeam !== installation.slack_team_id) return null;

  const isDm = event.type === "message";
  // A mention inside the bot's DM also arrives as message.im; answer it once.
  if (!isDm && event.channel.startsWith("D")) return null;

  const prompt = slackTextToPrompt(event.text ?? "", botUserId);
  if (!prompt) return null;

  return {
    channel: event.channel,
    threadTs: isDm ? event.thread_ts : (event.thread_ts ?? event.ts),
    userId: event.user,
    prompt,
  };
}

// Converts the agent's Markdown into Slack mrkdwn. Code blocks are kept as
// is (escaped only); prose gets bold, headings, bullets and links rewritten.
export function markdownToSlackMrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return escapeSlackText(part);
      return escapeSlackText(part)
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(
          /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_, label: string, url: string) =>
            `<${url.replace(/\|/g, "%7C")}|${label}>`,
        );
    })
    .join("");
}

// Cuts at a line break so a link or emphasis is never split, and closes a
// code block the cut left open.
export function truncateSlackText(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = "\n…";
  let cut = text.slice(0, max - suffix.length - 4);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > max / 2) cut = cut.slice(0, lastBreak);
  if ((cut.match(/```/g) ?? []).length % 2 === 1) cut += "\n```";
  return cut + suffix;
}

function extractSources(data: unknown): string[] {
  const raw = (data as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(raw)) return [];
  const urls = raw
    .map(s =>
      typeof s === "string" ? s : (s as { url?: unknown } | null)?.url,
    )
    .filter(
      (u): u is string => typeof u === "string" && /^https?:\/\//.test(u),
    );
  return [...new Set(urls)].slice(0, MAX_SOURCES);
}

// Builds the Slack reply from a finished agent run: the chat message when the
// run has one, else the extracted data, plus any source URLs.
export function buildAgentAnswerText(result: {
  message?: string;
  data?: unknown;
}): string {
  let body: string;
  if (typeof result.message === "string" && result.message.trim()) {
    body = markdownToSlackMrkdwn(result.message.trim());
  } else if (typeof result.data === "string" && result.data.trim()) {
    body = markdownToSlackMrkdwn(result.data.trim());
  } else if (result.data !== undefined && result.data !== null) {
    body = escapeSlackText(
      "```\n" + JSON.stringify(result.data, null, 2) + "\n```",
    );
  } else {
    body = "The agent finished without an answer.";
  }

  const sources = extractSources(result.data);
  const footer = sources.length
    ? "\n\n*Sources*\n" + sources.map(u => `• ${slackLink(u)}`).join("\n")
    : "";

  return truncateSlackText(body, SLACK_TEXT_LIMIT - footer.length) + footer;
}

type StartResult =
  | { ok: true; agentId: string }
  | {
      ok: false;
      reason:
        | "unavailable"
        | "no_api_key"
        | "banned"
        | "zdr"
        | "rate_limited"
        | "no_credits"
        | "failed";
    };

// The agent service calls back into the API with a team key, so runs started
// from Slack use the team's oldest regular API key.
async function getTeamApiKey(
  teamId: string,
): Promise<{ key: string; id: number } | null> {
  const rows = await dbRr
    .select({ key: schema.api_keys.key, id: schema.api_keys.id })
    .from(schema.api_keys)
    .where(
      and(
        eq(schema.api_keys.team_id, teamId),
        eq(schema.api_keys.agent_provisioned, false),
      ),
    )
    .orderBy(asc(schema.api_keys.created_at))
    .limit(1);
  const row = rows[0];
  return row?.key ? { key: row.key, id: row.id } : null;
}

// Applies the gates of the POST /v2/agent route (ban, ZDR, rate limit and
// credits) for the linked team, then starts the run.
async function startAgentForTeam(
  teamId: string,
  prompt: string,
): Promise<StartResult> {
  if (!config.EXTRACT_V3_BETA_URL) return { ok: false, reason: "unavailable" };

  const [acuc, apiKey] = await Promise.all([
    getACUCTeam(teamId, false, true, RateLimiterMode.Extract),
    getTeamApiKey(teamId),
  ]);
  if (!acuc) return { ok: false, reason: "unavailable" };
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  if (acuc.is_banned) return { ok: false, reason: "banned" };
  if (getScrapeZDR(acuc.flags) === "forced") {
    return { ok: false, reason: "zdr" };
  }

  const orgId = orgIdFromAcuc(acuc);
  try {
    const multiplier = await autumnService.getRateLimitMultiplier(
      teamId,
      orgId,
    );
    await getAutumnRateLimiter(
      RateLimiterMode.Extract,
      multiplier,
      acuc.flags,
    ).consume(teamId);
  } catch (error) {
    logger.warn("Slack agent run rate limited", { error, teamId });
    return { ok: false, reason: "rate_limited" };
  }

  let hasFreeRequest = false;
  if (config.USE_DB_AUTHENTICATION) {
    try {
      const data = await getAgentFreeRequestsLeft(teamId);
      hasFreeRequest = data?.[0]?.free_requests_left !== 0;
    } catch (error) {
      logger.warn("Failed to get agent free requests left", { error, teamId });
    }
  }
  if (!hasFreeRequest && orgId) {
    const credit = await autumnService.checkCredits({
      teamId,
      orgId,
      value: AGENT_MIN_CREDITS,
      properties: { source: "slackAgent", apiKeyId: apiKey.id },
    });
    // Fail open on an Autumn outage (null), like checkCreditsMiddleware.
    if (credit !== null && !credit.allowed) {
      return { ok: false, reason: "no_credits" };
    }
  }

  const agentId = uuidv7();
  const launched = await launchAgentJob({
    agentId,
    teamId,
    apiKey: apiKey.key,
    apiKeyId: apiKey.id,
    request: agentRequestSchema.parse({
      prompt,
      origin: "slack",
      mode: "chat",
    }),
  });
  if (!launched.ok) {
    logger.error("Failed to start Slack agent run", {
      agentId,
      teamId,
      status: launched.status,
      text: launched.text,
    });
    return { ok: false, reason: "failed" };
  }
  return { ok: true, agentId };
}

type WaitResult =
  | { status: "completed"; message?: string; data?: unknown }
  | { status: "failed"; error?: string }
  | { status: "needs_approval" }
  | { status: "timeout" };

async function waitForAgent(
  agentId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    let status: Awaited<ReturnType<typeof getExtractV3AgentStatus>>;
    try {
      status = await getExtractV3AgentStatus(agentId);
    } catch (error) {
      // Transient status errors are retried until the deadline.
      logger.warn("Slack agent status poll failed", { error, agentId });
      continue;
    }
    if (status.status === "success") {
      return {
        status: "completed",
        message: status.message,
        data: status.data,
      };
    }
    if (status.status === "failed") {
      return { status: "failed", error: status.error };
    }
    if (status.pendingApproval) return { status: "needs_approval" };
  }
  return { status: "timeout" };
}

function errorText(reason: string, agentId?: string): string {
  const ref = agentId ? ` (run \`${agentId}\`)` : "";
  switch (reason) {
    case "no_credits":
      return ":warning: Your Firecrawl team does not have enough credits for this request. Add credits or upgrade at https://firecrawl.dev/pricing.";
    case "rate_limited":
      return ":warning: Too many agent requests right now. Try again in a minute.";
    case "no_api_key":
      return ":warning: Your Firecrawl team has no API key. Create one in the Firecrawl dashboard, then try again.";
    case "zdr":
      return ":warning: The agent is not available for teams with zero data retention.";
    case "banned":
      return ":warning: This Firecrawl account cannot use the agent. Contact support@firecrawl.com.";
    case "timeout":
      return `:warning: This is taking longer than expected${ref}. Check the result in the Firecrawl dashboard.`;
    case "needs_approval":
      return `:warning: This run needs your approval${ref}. Open it in the Firecrawl dashboard to continue.`;
    default:
      return `:warning: Something went wrong while researching that${ref}. Try again later.`;
  }
}

// Slack retries an event when it gets no fast 2xx. Claim each event_id once so
// a slow ack or a second API replica never answers the same message twice.
async function claimEvent(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return true;
  const result = await redisEvictConnection.set(
    `slack-agent-event:${eventId}`,
    "1",
    "EX",
    EVENT_DEDUPE_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}

// Answers one @-mention or DM: posts a placeholder in the thread, runs the
// agent for the linked Firecrawl team, then replaces the placeholder with the
// answer or a short error.
export async function handleSlackAgentEvent(params: {
  installation: SlackInstallationRow;
  eventId?: string;
  event: RawSlackEvent;
  // Overridable for tests.
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const { installation } = params;
  const parsed = parseSlackAgentEvent(params.event, installation);
  if (!parsed) return;
  if (!(await claimEvent(params.eventId))) return;

  const token = decryptSlackToken(installation.bot_token);
  const placeholder = await postSlackMessage({
    token,
    channel: parsed.channel,
    text: PLACEHOLDER_TEXT,
    threadTs: parsed.threadTs,
  });
  if (!placeholder.ok || !placeholder.ts) {
    logger.warn("Failed to post Slack agent placeholder", {
      error: placeholder.error,
      teamId: installation.team_id,
    });
    return;
  }
  const reply = (text: string) =>
    updateSlackMessage({
      token,
      channel: parsed.channel,
      ts: placeholder.ts!,
      text,
    });

  let agentId: string | undefined;
  try {
    const started = await startAgentForTeam(
      installation.team_id,
      parsed.prompt,
    );
    if (!started.ok) {
      await reply(errorText(started.reason));
      return;
    }
    agentId = started.agentId;

    const result = await waitForAgent(
      agentId,
      params.timeoutMs ?? AGENT_TIMEOUT_MS,
      params.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
    if (result.status === "completed") {
      await reply(buildAgentAnswerText(result));
    } else {
      if (result.status === "failed") {
        logger.warn("Slack agent run failed", { agentId, error: result.error });
      }
      await reply(errorText(result.status, agentId));
    }
  } catch (error) {
    logger.error("Slack agent run errored", {
      error,
      agentId,
      teamId: installation.team_id,
    });
    await reply(errorText("failed", agentId)).catch(() => {});
  }
}
