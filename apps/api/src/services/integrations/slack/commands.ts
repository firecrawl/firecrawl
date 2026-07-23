import { z } from "zod";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import {
  createMonitor,
  createMonitorCheck,
  getMonitor,
  getMonitorForUpdate,
  listMonitorChecks,
  listMonitors,
  updateMonitor,
} from "../../monitoring/store";
import { enqueueMonitorCheck } from "../../monitoring/scheduler";
import { validateMonitorCron } from "../../monitoring/cron";
import {
  createMonitorSchema,
  type CreateMonitorRequest,
  type MonitorRow,
} from "../../monitoring/types";
import { getTeamBalance } from "../../autumn/usage";
import { autumnService } from "../../autumn/autumn.service";
import { getConcurrencyLimitActiveJobsCount } from "../../../lib/concurrency-redis";
import type { SlackInstallationRow } from "./types";
import { escapeSlackText, slackLink } from "./messages";

const logger = _logger.child({ module: "slack-commands" });

type SlackCommandResponse = {
  response_type: "ephemeral" | "in_channel";
  text: string;
  blocks?: unknown[];
};

type SlackSlashCommandInput = {
  installation: SlackInstallationRow;
  text: string;
  channelId: string;
  channelName: string;
  userId: string;
};

const DEFAULT_WATCH_CRON = "0 9 * * *"; // daily at 09:00 UTC

function dashboardUrl(path: string): string {
  return new URL(path, config.FIRECRAWL_DASHBOARD_URL).toString();
}

function ephemeral(text: string, blocks?: unknown[]): SlackCommandResponse {
  return { response_type: "ephemeral", text, blocks };
}

function invalidIdResponse(id: string): SlackCommandResponse {
  return ephemeral(
    `\`${escapeSlackText(id)}\` isn't a valid monitor id. Use \`/monitor list\` to find it.`,
  );
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + "…";
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Compact relative time: "3h ago" / "in 2h" / "just now".
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = then - Date.now();
  const mins = Math.round(Math.abs(diffMs) / 60000);
  if (mins < 1) return diffMs >= 0 ? "in <1m" : "just now";
  const unit =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return diffMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

function monitorStatusEmoji(status: string): string {
  switch (status) {
    case "active":
      return ":green_circle:";
    case "paused":
      return ":pause_button:";
    default:
      return ":white_circle:";
  }
}

function checkStatusEmoji(status: string): string {
  switch (status) {
    case "completed":
      return ":white_check_mark:";
    case "failed":
      return ":x:";
    case "partial":
      return ":warning:";
    case "queued":
    case "running":
      return ":hourglass_flowing_sand:";
    default:
      return ":fast_forward:"; // skipped_*
  }
}

// Human summary of what a monitor watches (URLs / crawl root / search queries).
function describeTargets(monitor: MonitorRow): string[] {
  const targets = Array.isArray(monitor.targets) ? monitor.targets : [];
  const parts: string[] = [];
  for (const t of targets as Array<Record<string, any>>) {
    if (t?.type === "scrape" && Array.isArray(t.urls)) {
      parts.push(...t.urls.map((u: unknown) => String(u)));
    } else if (t?.type === "crawl" && typeof t.url === "string") {
      parts.push(t.url);
    } else if (t?.type === "search" && Array.isArray(t.queries)) {
      parts.push(...t.queries.map((q: unknown) => `"${String(q)}"`));
    }
  }
  return parts;
}

function joinList(items: string[], max: number): string {
  if (items.length === 0) return "—";
  const shown = items.slice(0, max).join(", ");
  const extra = items.length - max;
  return extra > 0 ? `${shown} …+${extra} more` : shown;
}

function monitorHasSearchTarget(monitor: MonitorRow): boolean {
  return (Array.isArray(monitor.targets) ? monitor.targets : []).some(
    t => (t as { type?: string })?.type === "search",
  );
}

function helpResponse(): SlackCommandResponse {
  const lines = [
    "*Firecrawl `/monitor` — commands*",
    "`/monitor watch <url> [prompt]` — monitor a page; add a prompt to alert only on *meaningful* changes",
    "`/monitor watch <prompt>` — monitor the *whole web* for new results matching the prompt",
    "`/monitor list` — list your monitors",
    "`/monitor get <id>` — show a monitor's details",
    "`/monitor checks <id>` — recent check history",
    "`/monitor run <id>` — run a check now",
    "`/monitor pause <id>` · `/monitor resume <id>` — pause or resume",
    "`/monitor help` — show this",
    "",
    `Account & credits: \`/firecrawl account\`. Delete monitors from the ${slackLink(dashboardUrl("/app/monitoring"), "dashboard")}.`,
  ];
  return ephemeral(lines.join("\n"));
}

// The `/firecrawl` slash command — account/workspace things that aren't
// monitor-specific. Monitoring lives under `/monitor`.
function firecrawlHelpResponse(): SlackCommandResponse {
  const lines = [
    "*Firecrawl `/firecrawl` — commands*",
    "`/firecrawl account` — credits, plan usage, and concurrency",
    "`/firecrawl status` — this workspace's Firecrawl connection",
    "`/firecrawl help` — show this",
    "",
    "Monitoring lives under `/monitor` — try `/monitor help`.",
  ];
  return ephemeral(lines.join("\n"));
}

export async function handleFirecrawlCommand(
  input: SlackSlashCommandInput,
): Promise<SlackCommandResponse> {
  const [subcommand] = input.text.trim().split(/\s+/);
  switch ((subcommand || "").toLowerCase()) {
    case "":
    case "account":
    case "usage":
    case "credits":
    case "whoami":
    case "me":
      // Bare `/firecrawl` defaults to the account overview.
      return accountResponse(input.installation);
    case "status":
    case "connection":
      return statusResponse(input.installation);
    case "help":
      return firecrawlHelpResponse();
    default:
      return firecrawlHelpResponse();
  }
}

function statusResponse(
  installation: SlackInstallationRow,
): SlackCommandResponse {
  const workspace = installation.slack_team_name ?? installation.slack_team_id;
  return ephemeral(
    [
      `:white_check_mark: This Slack workspace (*${escapeSlackText(workspace)}*) is linked to your Firecrawl account.`,
      "Monitors created here bill your team's API key automatically — no key to paste.",
      `Open the ${slackLink(dashboardUrl("/app/monitoring"), "monitoring dashboard")} to configure more.`,
    ].join("\n"),
  );
}

async function listResponse(
  installation: SlackInstallationRow,
): Promise<SlackCommandResponse> {
  const monitors = await listMonitors({
    teamId: installation.team_id,
    limit: 20,
    offset: 0,
  });

  if (monitors.length === 0) {
    return ephemeral(
      `You don't have any monitors yet. Try \`/monitor watch https://example.com\` or open the ${slackLink(
        dashboardUrl("/app/monitoring/new"),
        "dashboard",
      )}.`,
    );
  }

  const lines = monitors.map(m => {
    const statusEmoji =
      m.status === "active" ? ":green_circle:" : ":pause_button:";
    const slackOn =
      (m.notification as { slack?: { enabled?: boolean } } | null)?.slack
        ?.enabled === true
        ? " · Slack on"
        : "";
    return `${statusEmoji} *${escapeSlackText(m.name)}* — \`${m.id}\`${slackOn}`;
  });

  return ephemeral(
    [`*Your monitors (${monitors.length}):*`, ...lines].join("\n"),
  );
}

// Detects a URL as the first token — accepts explicit http(s):// and bare
// domains like "example.com/pricing" (prepends https://). Returns the
// normalized URL, or null when the token isn't URL-like (→ web search monitor).
function parseWatchUrl(token: string): string | null {
  const looksLikeDomain = /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?(\?\S*)?$/i.test(
    token,
  );
  const candidate = /^https?:\/\//i.test(token)
    ? token
    : looksLikeDomain
      ? `https://${token}`
      : token;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// `/monitor watch ...`: a URL as the first token creates a page (scrape)
// monitor; otherwise the whole text is a web-search monitor goal — i.e. monitor
// the entire web for new results matching the prompt.
async function watchResponse(
  input: SlackSlashCommandInput,
  arg: string,
): Promise<SlackCommandResponse> {
  const trimmedArg = arg.trim();
  const spaceIdx = trimmedArg.search(/\s/);
  const firstToken =
    spaceIdx === -1 ? trimmedArg : trimmedArg.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmedArg.slice(spaceIdx + 1).trim();

  const url = parseWatchUrl(firstToken);
  if (url) {
    return createWebsiteMonitor(input, url, rest);
  }
  // No URL → monitor the whole web using the full prompt as the goal.
  return createSearchMonitor(input, trimmedArg);
}

async function createWebsiteMonitor(
  input: SlackSlashCommandInput,
  url: string,
  goalText: string,
): Promise<SlackCommandResponse> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  const goal = goalText.trim();
  const hasGoal = goal.length > 0;

  try {
    const parsedInput = createMonitorSchema.parse({
      name: `Slack: ${host}`,
      schedule: { cron: DEFAULT_WATCH_CRON, timezone: "UTC" },
      targets: [
        {
          type: "scrape",
          urls: [url],
          scrapeOptions: { formats: ["markdown"] },
        },
      ],
      notification: {
        slack: {
          enabled: true,
          channelId: input.channelId,
          channelName: input.channelName,
        },
      },
      // A prompt enables meaningful-change judging, so we only alert on changes
      // that match what the user asked to watch for.
      ...(hasGoal ? { goal, judgeEnabled: true } : {}),
      origin: "slack",
    });

    const monitor = await createMonitorFromInput(input, parsedInput);

    const lead = hasGoal
      ? `:fire: Now monitoring ${slackLink(url)} for: _${escapeSlackText(goal)}_\nOnly *meaningful* changes will be posted to *#${escapeSlackText(input.channelName)}*.`
      : `:fire: Now monitoring ${slackLink(url)} — changes will be posted to *#${escapeSlackText(input.channelName)}*.\n_Add a prompt to alert only on meaningful changes, e.g. \`/monitor watch <url> pricing changes\`._`;

    return ephemeral([lead, ...watchFooter(monitor.id)].join("\n"));
  } catch (error) {
    return createFailedResponse(input, error);
  }
}

async function createSearchMonitor(
  input: SlackSlashCommandInput,
  goalText: string,
): Promise<SlackCommandResponse> {
  const goal = goalText.trim();
  if (!goal) {
    return ephemeral(
      "Usage: `/monitor watch <url>` to watch a page, or `/monitor watch <what to watch the web for>` to monitor the whole web.",
    );
  }

  try {
    const parsedInput = createMonitorSchema.parse({
      name: `Slack: ${truncate(goal, 80)}`,
      schedule: { cron: DEFAULT_WATCH_CRON, timezone: "UTC" },
      goal,
      judgeEnabled: true,
      targets: [
        {
          type: "search",
          queries: [goal.slice(0, 256)],
          searchWindow: "24h",
          maxResults: 10,
        },
      ],
      notification: {
        slack: {
          enabled: true,
          channelId: input.channelId,
          channelName: input.channelName,
        },
      },
      origin: "slack",
    });

    const monitor = await createMonitorFromInput(input, parsedInput);

    return ephemeral(
      [
        `:mag: Now monitoring *the web* for: _${escapeSlackText(goal)}_`,
        `New matching results will be posted to *#${escapeSlackText(input.channelName)}*.`,
        ...watchFooter(monitor.id),
      ].join("\n"),
    );
  } catch (error) {
    return createFailedResponse(input, error);
  }
}

function watchFooter(monitorId: string): string[] {
  return [
    `Runs daily. Manage it in the ${slackLink(
      dashboardUrl(`/app/monitoring/${monitorId}`),
      "dashboard",
    )} (\`${monitorId}\`).`,
    `_Tip: if you don't see alerts in a private channel, invite the bot with \`/invite @Firecrawl\`._`,
  ];
}

async function createMonitorFromInput(
  input: SlackSlashCommandInput,
  parsedInput: CreateMonitorRequest,
): Promise<MonitorRow> {
  const schedule = validateMonitorCron(
    parsedInput.schedule.cron,
    parsedInput.schedule.timezone,
  );
  return createMonitor({
    teamId: input.installation.team_id,
    input: parsedInput,
    nextRunAt: schedule.nextRunAt,
    intervalMs: schedule.intervalMs,
  });
}

function createFailedResponse(
  input: SlackSlashCommandInput,
  error: unknown,
): SlackCommandResponse {
  logger.warn("Failed to create monitor from slash command", {
    error,
    teamId: input.installation.team_id,
  });
  return ephemeral(
    "Sorry, I couldn't create that monitor. Please try again from the dashboard.",
  );
}

async function cancelResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();

  // Validate the id shape first: a non-UUID arg gets a friendly message and
  // avoids hitting the DB with an invalid uuid cast (which would throw).
  if (!z.uuid().safeParse(trimmed).success) {
    return ephemeral(
      `\`${escapeSlackText(trimmed)}\` isn't a valid monitor id. Use \`/monitor list\` to find it.`,
    );
  }

  // No catch here on purpose: a valid-but-missing id returns null, while real
  // backend errors propagate to the command handler's try/catch so we don't
  // disguise a failure as "not found".
  const existing = await getMonitorForUpdate(installation.team_id, trimmed);
  if (!existing) {
    return ephemeral(
      `I couldn't find a monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }

  const updated = await updateMonitor({
    teamId: installation.team_id,
    monitorId: trimmed,
    input: { status: "paused" },
  });

  if (!updated) {
    return ephemeral(
      "Sorry, I couldn't pause that monitor. Try the dashboard.",
    );
  }

  return ephemeral(
    `:pause_button: Paused *${escapeSlackText(updated.name)}* (\`${updated.id}\`). Resume it anytime from the ${slackLink(
      dashboardUrl(`/app/monitoring/${updated.id}`),
      "dashboard",
    )}.`,
  );
}

// CLI `firecrawl --status` / `credit-usage` equivalent: credits, plan usage,
// and live concurrency for the linked team — no API key to paste.
async function accountResponse(
  installation: SlackInstallationRow,
): Promise<SlackCommandResponse> {
  const teamId = installation.team_id;
  const [balance, concurrencyLimit, activeJobs] = await Promise.all([
    getTeamBalance(teamId).catch(() => null),
    autumnService.getConcurrencyLimit(teamId).catch(() => null),
    getConcurrencyLimitActiveJobsCount(teamId).catch(() => null),
  ]);

  const lines: string[] = [":bar_chart: *Your Firecrawl account*"];

  if (balance) {
    if (balance.unlimited) {
      lines.push("*Credits:* Unlimited");
    } else if (balance.planCredits > 0) {
      const pctLeft = Math.max(
        0,
        Math.min(
          100,
          Math.round((balance.remaining / balance.planCredits) * 100),
        ),
      );
      lines.push(
        `*Credits:* ${formatNumber(balance.remaining)} / ${formatNumber(balance.planCredits)} (${pctLeft}% left this cycle)`,
      );
    } else {
      lines.push(
        `*Credits:* ${formatNumber(balance.remaining)} remaining (pay-as-you-go)`,
      );
    }
    if (balance.periodStart && balance.periodEnd) {
      lines.push(
        `*Billing period:* ${formatShortDate(balance.periodStart)} – ${formatShortDate(balance.periodEnd)}`,
      );
    }
  } else {
    lines.push("*Credits:* unavailable right now");
  }

  if (typeof concurrencyLimit === "number") {
    lines.push(
      `*Concurrency:* ${activeJobs ?? 0} / ${concurrencyLimit} active`,
    );
  }

  const workspace = installation.slack_team_name ?? installation.slack_team_id;
  lines.push(`*Slack:* connected to *${escapeSlackText(workspace)}*`);
  lines.push(
    `Open the ${slackLink(dashboardUrl("/app/monitoring"), "dashboard")}.`,
  );

  return ephemeral(lines.join("\n"));
}

// `firecrawl monitor get <id>` — a readable monitor summary.
async function getResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();
  if (!z.uuid().safeParse(trimmed).success) return invalidIdResponse(trimmed);

  const m = await getMonitor(installation.team_id, trimmed);
  if (!m) {
    return ephemeral(
      `No monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }

  const notif = m.notification as {
    email?: { enabled?: boolean };
    slack?: { enabled?: boolean; channelName?: string };
  } | null;
  const slackTarget = notif?.slack?.enabled
    ? notif.slack.channelName
      ? `#${notif.slack.channelName}`
      : "on"
    : "off";
  const summary = m.last_check_summary;

  const lines = [
    `${monitorStatusEmoji(m.status)} *${escapeSlackText(m.name)}*  \`${m.id}\``,
    `*Watching:* ${escapeSlackText(joinList(describeTargets(m), 5))}`,
    `*Schedule:* \`${escapeSlackText(m.schedule_cron)}\` (${escapeSlackText(m.schedule_timezone)}) · next ${relativeTime(m.next_run_at)}`,
    `*Goal:* ${
      m.goal
        ? `${escapeSlackText(truncate(m.goal, 200))} · meaningful-only ${m.judge_enabled ? "on" : "off"}`
        : "—"
    }`,
    `*Notifications:* email ${notif?.email?.enabled ? "on" : "off"} · slack ${slackTarget}`,
  ];
  if (summary) {
    lines.push(
      `*Last check:* ${summary.changed} changed · ${summary.new} new · ${summary.removed} removed · ${summary.error} errors`,
    );
  }
  lines.push(
    `Open in the ${slackLink(dashboardUrl(`/app/monitoring/${m.id}`), "dashboard")}.`,
  );
  return ephemeral(lines.join("\n"));
}

// `firecrawl monitor checks <id>` — recent check history.
async function checksResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();
  if (!z.uuid().safeParse(trimmed).success) return invalidIdResponse(trimmed);

  const monitor = await getMonitor(installation.team_id, trimmed);
  if (!monitor) {
    return ephemeral(
      `No monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }

  const checks = await listMonitorChecks({
    teamId: installation.team_id,
    monitorId: trimmed,
    limit: 8,
    offset: 0,
  });
  if (checks.length === 0) {
    return ephemeral(
      `No checks yet for *${escapeSlackText(monitor.name)}*. Run one with \`/monitor run ${monitor.id}\`.`,
    );
  }

  const lines = checks.map(c => {
    const when = relativeTime(c.finished_at ?? c.started_at ?? c.created_at);
    return `${checkStatusEmoji(c.status)} ${escapeSlackText(c.status)} · ${when} · ${c.changed_count}c ${c.new_count}n ${c.removed_count}r ${c.error_count}e`;
  });
  return ephemeral(
    [`*Recent checks — ${escapeSlackText(monitor.name)}:*`, ...lines].join(
      "\n",
    ),
  );
}

// `firecrawl monitor run <id>` — trigger a check now.
async function runResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();
  if (!z.uuid().safeParse(trimmed).success) return invalidIdResponse(trimmed);

  const monitor = await getMonitorForUpdate(installation.team_id, trimmed);
  if (!monitor) {
    return ephemeral(
      `No monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }
  if (monitor.status === "paused") {
    return ephemeral(
      `*${escapeSlackText(monitor.name)}* is paused. Resume it first: \`/monitor resume ${monitor.id}\`.`,
    );
  }
  if (monitor.current_check_id) {
    return ephemeral(
      `A check is already running for *${escapeSlackText(monitor.name)}*.`,
    );
  }

  const check = await createMonitorCheck({ monitor, trigger: "manual" });
  await enqueueMonitorCheck({
    monitorId: monitor.id,
    checkId: check.id,
    teamId: monitor.team_id,
    search: monitorHasSearchTarget(monitor),
  });

  return ephemeral(
    `:arrows_counterclockwise: Started a check for *${escapeSlackText(monitor.name)}*. Results post here when it finishes.`,
  );
}

// `firecrawl monitor update <id> --state active` — resume a paused monitor.
async function resumeResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();
  if (!z.uuid().safeParse(trimmed).success) return invalidIdResponse(trimmed);

  const existing = await getMonitorForUpdate(installation.team_id, trimmed);
  if (!existing) {
    return ephemeral(
      `No monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }

  const updated = await updateMonitor({
    teamId: installation.team_id,
    monitorId: trimmed,
    input: { status: "active" },
  });
  if (!updated) {
    return ephemeral(
      "Sorry, I couldn't resume that monitor. Try the dashboard.",
    );
  }

  return ephemeral(
    `:green_circle: Resumed *${escapeSlackText(updated.name)}*. Next run ${relativeTime(updated.next_run_at)}.`,
  );
}

// Routes a parsed /monitor invocation to the right sub-handler.
export async function handleSlashCommand(
  input: SlackSlashCommandInput,
): Promise<SlackCommandResponse> {
  const text = input.text.trim();
  const [subcommand, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch ((subcommand || "help").toLowerCase()) {
    case "":
    case "help":
      return helpResponse();
    case "list":
    case "ls":
      return listResponse(input.installation);
    case "get":
    case "show":
    case "info":
      if (!arg) return ephemeral("Usage: `/monitor get <monitor-id>`");
      return getResponse(input.installation, arg);
    case "checks":
    case "history":
      if (!arg) return ephemeral("Usage: `/monitor checks <monitor-id>`");
      return checksResponse(input.installation, arg);
    case "run":
      if (!arg) return ephemeral("Usage: `/monitor run <monitor-id>`");
      return runResponse(input.installation, arg);
    case "watch":
    case "add":
      if (!arg) {
        return ephemeral(
          [
            "Usage:",
            "• `/monitor watch <url> [what to watch for]` — watch a page",
            "• `/monitor watch <what to watch the web for>` — watch the whole web",
            "Example: `/monitor watch https://example.com/pricing pricing changes`",
          ].join("\n"),
        );
      }
      return watchResponse(input, arg);
    case "cancel":
    case "pause":
    case "stop":
      if (!arg) {
        return ephemeral("Usage: `/monitor pause <monitor-id>`");
      }
      return cancelResponse(input.installation, arg);
    case "resume":
    case "start":
    case "unpause":
      if (!arg) return ephemeral("Usage: `/monitor resume <monitor-id>`");
      return resumeResponse(input.installation, arg);
    default:
      // Bare `/monitor <url>` is a convenient alias for watch.
      if (/^https?:\/\//i.test(text)) {
        return watchResponse(input, text);
      }
      return helpResponse();
  }
}
