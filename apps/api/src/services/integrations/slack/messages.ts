export type MonitorSlackPage = {
  url: string;
  status: string;
  judgment?: {
    meaningful: boolean;
    reason: string;
  } | null;
};

type MonitorSlackPayload = {
  monitorName: string;
  dashboardUrl: string;
  checkId: string;
  summary: {
    changed: number;
    new: number;
    removed: number;
    error: number;
    totalPages: number;
  };
  pages: MonitorSlackPage[];
  creditsUsed: number | null;
};

const MAX_PAGE_BLOCKS = 8;
// Slack caps a section block's `text` at 3000 chars; exceeding it makes the whole
// chat.postMessage fail (invalid_blocks), dropping the alert. URLs are the only
// unbounded input we render, so bound them and clamp the assembled line.
const SECTION_TEXT_LIMIT = 3000;
const MAX_LINK_URL_LEN = 2000;

// Slack mrkdwn requires these three characters escaped in text spans.
export function escapeSlackText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackLink(url: string, label?: string): string {
  // Strip the angle brackets that delimit a link, and percent-encode the pipe:
  // inside `<...>` Slack treats the first `|` as the URL/label separator, so an
  // unescaped `|` in a user-controlled URL can spoof the displayed link text.
  const safeUrl = url.replace(/[<>]/g, "").replace(/\|/g, "%7C");
  if (!label) return `<${safeUrl}>`;
  return `<${safeUrl}|${escapeSlackText(label)}>`;
}

// Renders a page URL for a section: clickable when short enough, otherwise a
// truncated, non-clickable, escaped string so a pathological URL can't blow past
// Slack's section text limit and drop the whole alert.
function boundedPageLink(url: string): string {
  if (url.length <= MAX_LINK_URL_LEN) return slackLink(url);
  return escapeSlackText(truncate(url, MAX_LINK_URL_LEN));
}

// Builds the change-detection alert posted to a channel. Returns both a
// fallback `text` (for notifications/screen readers) and rich Block Kit blocks.
export function buildMonitorAlertMessage(payload: MonitorSlackPayload): {
  text: string;
  blocks: unknown[];
} {
  const { summary } = payload;

  // Meaningful changes first — those carry the description the reader cares about.
  const sortedPages = [...payload.pages].sort((a, b) => {
    const aM = a.judgment?.meaningful === true ? 0 : 1;
    const bM = b.judgment?.meaningful === true ? 0 : 1;
    return aM - bM;
  });
  const shownPages = sortedPages.slice(0, MAX_PAGE_BLOCKS);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔥 ${truncate(payload.monitorName, 140)}`,
        emoji: true,
      },
    },
  ];

  // Headline each page with WHAT changed (the judged description). The page's
  // status + URL becomes a small secondary context line beneath it.
  for (const page of shownPages) {
    const reason = page.judgment?.reason?.trim();
    const tag = page.judgment
      ? page.judgment.meaningful
        ? " · _meaningful_"
        : " · _noise_"
      : "";
    const meta = `${statusEmoji(page.status)} *${escapeSlackText(page.status)}* · ${boundedPageLink(page.url)}${tag}`;

    if (reason) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          // The change description leads; clamp only at Slack's hard limit.
          text: truncate(escapeSlackText(reason), SECTION_TEXT_LIMIT),
        },
      });
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: truncate(meta, SECTION_TEXT_LIMIT) }],
      });
    } else {
      // No judged description (e.g. unjudged monitor) — the page itself leads.
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: truncate(meta, SECTION_TEXT_LIMIT) },
      });
    }
  }

  const remaining = sortedPages.length - shownPages.length;
  if (remaining > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${remaining} more page(s).` }],
    });
  }

  blocks.push({ type: "divider" });

  // Secondary: a compact one-line tally (only non-zero categories + total).
  const meaningfulCount = payload.pages.filter(
    p => p.judgment?.meaningful === true,
  ).length;
  const counts: string[] = [];
  if (summary.changed > 0) {
    counts.push(
      `${summary.changed} changed${meaningfulCount > 0 ? ` (${meaningfulCount} meaningful)` : ""}`,
    );
  }
  if (summary.new > 0) counts.push(`${summary.new} new`);
  if (summary.removed > 0) counts.push(`${summary.removed} removed`);
  if (summary.error > 0) {
    counts.push(`${summary.error} error${summary.error === 1 ? "" : "s"}`);
  }
  counts.push(`${summary.totalPages} checked`);

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: counts.join("  ·  ") }],
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View in dashboard", emoji: true },
        url: payload.dashboardUrl,
        style: "primary",
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Check \`${escapeSlackText(payload.checkId)}\`${
          payload.creditsUsed != null ? ` • ${payload.creditsUsed} credits` : ""
        }`,
      },
    ],
  });

  // Notification preview / fallback text also leads with the change itself.
  const leadReason =
    shownPages.find(p => p.judgment?.meaningful && p.judgment.reason)?.judgment
      ?.reason ?? shownPages.find(p => p.judgment?.reason)?.judgment?.reason;
  const text = leadReason
    ? `${payload.monitorName}: ${truncate(leadReason.trim(), 280)}`
    : `Monitor "${payload.monitorName}" detected activity: ${summary.changed} changed, ${summary.new} new, ${summary.removed} removed, ${summary.error} errors.`;

  return { text, blocks };
}

function statusEmoji(status: string): string {
  switch (status) {
    case "changed":
      return ":large_orange_diamond:";
    case "new":
      return ":large_green_circle:";
    case "removed":
      return ":red_circle:";
    case "error":
      return ":warning:";
    default:
      return ":small_blue_diamond:";
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + "…";
}
