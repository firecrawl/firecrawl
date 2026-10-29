import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import type { SlackChannel, SlackOAuthResult } from "./types";

const logger = _logger.child({ module: "slack-client" });

const SLACK_API_BASE = "https://slack.com/api";

type SlackApiResponse = {
  ok: boolean;
  error?: string;
  warning?: string;
  [key: string]: unknown;
};

async function slackPost<T extends SlackApiResponse>(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!json.ok) {
    logger.warn("Slack API call failed", { method, error: json.error });
  }
  return json;
}

async function slackGet<T extends SlackApiResponse>(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as T;
  if (!json.ok) {
    logger.warn("Slack API call failed", { method, error: json.error });
  }
  return json;
}

// Exchanges an OAuth authorization code for a bot token. Sends the client
// credentials as form-encoded params per Slack's oauth.v2.access contract.
export async function exchangeOAuthCode(params: {
  code: string;
  redirectUri: string;
}): Promise<SlackOAuthResult> {
  const clientId = config.SLACK_CLIENT_ID;
  const clientSecret = config.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: "slack_not_configured" };
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  const res = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = (await res.json()) as SlackOAuthResult;
  if (!json.ok) {
    logger.warn("Slack oauth.v2.access failed", { error: json.error });
  }
  return json;
}

export async function postSlackMessage(params: {
  token: string;
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}): Promise<{ ok: boolean; error?: string; ts?: string }> {
  const res = await slackPost<
    SlackApiResponse & { ts?: string; channel?: string }
  >("chat.postMessage", params.token, {
    channel: params.channel,
    text: params.text,
    blocks: params.blocks,
    thread_ts: params.threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ok: res.ok, error: res.error, ts: res.ts };
}

// Delivers a delayed slash-command result via the response_url Slack includes
// in the payload (valid ~30 minutes). Used so the command endpoint can ack
// within Slack's 3-second deadline and do the real work asynchronously.
export async function postToResponseUrl(
  responseUrl: string,
  message: {
    response_type: "ephemeral" | "in_channel";
    text: string;
    blocks?: unknown[];
  },
): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    logger.warn("Slack response_url delivery failed", { status: res.status });
  }
}

// Public channels can be auto-joined by the bot; private channels require a
// manual invite (surfaced to the user as an error).
export async function joinChannel(params: {
  token: string;
  channel: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await slackPost<SlackApiResponse>(
    "conversations.join",
    params.token,
    { channel: params.channel },
  );
  return { ok: res.ok, error: res.error };
}

type SlackConversation = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
};

// Lists channels the workspace exposes to the bot, paging through Slack's
// cursor pagination up to a sane cap so we don't hammer the API for huge orgs.
export async function listChannels(params: {
  token: string;
  limit?: number;
}): Promise<{ ok: boolean; error?: string; channels: SlackChannel[] }> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  const hardCap = params.limit ?? 1000;

  for (let page = 0; page < 10; page++) {
    const query: Record<string, string> = {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) query.cursor = cursor;

    const res = await slackGet<
      SlackApiResponse & {
        channels?: SlackConversation[];
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.list", params.token, query);

    if (!res.ok) {
      return { ok: false, error: res.error, channels };
    }

    for (const ch of res.channels ?? []) {
      if (ch.is_archived) continue;
      channels.push({
        id: ch.id,
        name: ch.name ?? ch.id,
        isPrivate: Boolean(ch.is_private),
        isMember: Boolean(ch.is_member),
      });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor || channels.length >= hardCap) break;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels };
}
