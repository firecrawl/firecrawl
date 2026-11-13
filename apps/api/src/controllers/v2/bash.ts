import cors from "cors";
import express, {
  type Application,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { isIPv4 } from "net";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { config } from "../../config";
import {
  MAX_FIRECRAWL_CALLS,
  MAX_OUTPUT_BYTES,
  TIMEOUT_MS,
} from "../../lib/hosted-bash/limits";
import {
  ShellBusyError,
  runShell,
  type ShellResult,
} from "../../lib/hosted-bash/shell";
import { keylessTeamId, keylessTeamUuid } from "../../lib/keyless-team";
import { logger } from "../../lib/logger";
import { capturePostHog } from "../../services/posthog-capture";
import { redisRateLimitClient } from "../../services/rate-limiter";

const ROUTE = "/v2/bash";
const RUN_EVENT = "bash_command_run";
const USAGE_EVENT = "bash_usage_viewed";
const MAX_COMMAND_BYTES = 64 * 1024;
const COMMANDS_PER_MINUTE = 60;
// CLI commands worth counting by name; any other word after `firecrawl` is "other".
const CLI_COMMANDS = new Set([
  "search",
  "scrape",
  "crawl",
  "map",
  "extract",
  "agent",
  "parse",
  "download",
  "batch-scrape",
  "interact",
  "browser",
  "monitor",
  "login",
  "init",
  "help",
]);

function usage(base: string): string {
  return `Firecrawl Bash

A hosted shell for agents. Send one bash command over HTTP and get its output back.
A subset of the Firecrawl CLI (search and scrape) is built in as \`firecrawl\`, and the
live Firecrawl docs are mounted at /docs. No API key, MCP server or install needed.

Run a command:
  curl ${base} --data-binary 'firecrawl search "stripe pricing" --limit 3'
  curl ${base} --data-binary 'firecrawl scrape https://stripe.com/pricing | head -40'
  curl ${base} --data-binary 'firecrawl --help'
  GET  ${base}?command=firecrawl%20search%20stripe%20pricing
  POST ${base}   JSON: {"command": "..."}

Read the Firecrawl docs:
  curl ${base} --data-binary 'cat /docs/llms.txt | head -40'
  curl ${base} --data-binary 'grep -l -r keyless /docs/features'

Pipes, grep, jq, sed, awk and loops work, for example:
  curl ${base} --data-binary 'firecrawl search "firecrawl changelog" --limit 5 --json | jq -r ".data.web[].url"'

Response:
  Plain text (stdout, then stderr) by default. Add ?format=json or Accept: application/json
  for stdout, stderr, exitCode, durationMs and truncated. X-Exit-Code is set on every run.

Without an API key, firecrawl runs on the free keyless tier, limited per IP per day.
A limit message includes a link to a free API key; send one as Authorization: Bearer fc-...
for higher limits. For crawl, map and everything else, install the Firecrawl CLI:
npx -y firecrawl-cli@latest init

Limits: ${MAX_COMMAND_BYTES} byte commands, ${MAX_OUTPUT_BYTES} bytes of stdout and stderr each,
${TIMEOUT_MS / 1000} seconds and ${MAX_FIRECRAWL_CALLS} Firecrawl calls per command. Nothing persists between requests.
`;
}

/**
 * Commands per IP per minute across every replica. Firecrawl calls also count
 * against the keyless tier or the caller's plan; commands that make none have
 * only this limit.
 */
function createRateLimit(): RequestHandler {
  const memory = new RateLimiterMemory({
    points: COMMANDS_PER_MINUTE,
    duration: 60,
  });
  const limiter = config.REDIS_RATE_LIMIT_URL
    ? new RateLimiterRedis({
        storeClient: redisRateLimitClient,
        keyPrefix: "hosted-bash",
        points: COMMANDS_PER_MINUTE,
        duration: 60,
        insuranceLimiter: memory,
      })
    : memory;
  return async (req, res, next) => {
    try {
      await limiter.consume(req.ip ?? "unknown");
      next();
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) return next(rejection);
      const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
      res.setHeader("Retry-After", String(seconds));
      res
        .status(429)
        .type("text/plain")
        .send(`Too many commands. Try again in ${seconds} seconds.\n`);
    }
  };
}

/** The command sent, undefined when none was, or null for a JSON body without one. */
function readCommand(req: Request): string | null | undefined {
  const fromQuery =
    typeof req.query.command === "string" ? req.query.command : undefined;
  const body = typeof req.body === "string" ? req.body : "";
  if (!body.trim()) return fromQuery;
  const json = req.is("application/json");
  // A JSON object is a request even without its content type; a brace group
  // like `{ echo a; }` does not parse, so it stays a command.
  if (json || body.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return typeof parsed.command === "string" ? parsed.command : null;
      }
    } catch {}
    if (json) return null;
  }
  // curl --data-urlencode 'command=...' sends a form; --data-binary also labels
  // a raw command as a form, so only the command= field is decoded.
  if (
    req.is("application/x-www-form-urlencoded") &&
    body.startsWith("command=")
  ) {
    return new URLSearchParams(body).get("command") ?? "";
  }
  return body;
}

/** Where this server answered the request, so the shell can call its routes. */
function ownBaseUrl(req: Request): string {
  const { localAddress, localPort } = req.socket;
  const host = !localAddress
    ? "127.0.0.1"
    : localAddress.startsWith("::ffff:")
      ? localAddress.slice(7)
      : localAddress.includes(":")
        ? `[${localAddress}]`
        : localAddress;
  return `http://${host}:${localPort}`;
}

/** Records a usage view, or the shape of a run (subcommands, outcome), never the command text. */
function track(
  req: Request,
  ownKey: boolean,
  run?: { command: string; result: ShellResult },
) {
  const ip = (req.ip ?? "").replace(/^::ffff:/i, "");
  // The id keyless_prompt_shown uses, so keyless runs join to prompts and signups.
  const keylessTeam =
    !ownKey && isIPv4(ip) ? keylessTeamUuid(keylessTeamId(ip)) : null;
  const event = run ? RUN_EVENT : USAGE_EVENT;
  const properties = {
    keyless_team_id: keylessTeam,
    user_agent: req.get("user-agent")?.slice(0, 300) ?? null,
    method: req.method,
    own_key: ownKey,
    ...(run
      ? {
          subcommands: [
            ...new Set(
              [...run.command.matchAll(/\bfirecrawl\s+([a-z][\w-]*)/g)].map(
                match => (CLI_COMMANDS.has(match[1]) ? match[1] : "other"),
              ),
            ),
          ],
          exit_code: run.result.exitCode,
          duration_ms: run.result.durationMs,
          endpoints: run.result.endpoints,
          failed_endpoints: run.result.failedEndpoints,
          truncated: run.result.truncated,
        }
      : {}),
  };
  logger.info("Hosted bash request", {
    module: "hosted-bash",
    event,
    ...properties,
  });
  void capturePostHog(event, keylessTeam ?? "hosted-bash-anonymous", {
    ...properties,
    // Callers are anonymous IPs: do not create a person for each one.
    $process_person_profile: false,
  });
}

async function bashController(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  const sent = req.method === "HEAD" ? undefined : readCommand(req);
  const authorization = req.get("authorization")?.trim() || null;

  if (sent === null) {
    res
      .status(400)
      .type("text/plain")
      .send('Send JSON as {"command": "..."}, or the command as the body.\n');
    return;
  }
  const command = sent?.trim();
  if (!command) {
    track(req, Boolean(authorization));
    res
      .type("text/plain")
      .send(usage(`${req.protocol}://${req.get("host")}${ROUTE}`));
    return;
  }
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    res
      .status(413)
      .type("text/plain")
      .send(`command is larger than ${MAX_COMMAND_BYTES} bytes\n`);
    return;
  }

  const userAgent = req.get("user-agent")?.slice(0, 500);
  const worldId = req.get("x-firecrawl-world-id");
  const closed = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) closed.abort();
  });
  let result: ShellResult;
  try {
    result = await runShell(
      command,
      {
        baseUrl: ownBaseUrl(req),
        ip: req.ip ?? null,
        authorization,
        headers: {
          ...(userAgent ? { "User-Agent": userAgent } : {}),
          ...(worldId ? { "X-Firecrawl-World-Id": worldId } : {}),
        },
      },
      closed.signal,
    );
  } catch (error) {
    if (!(error instanceof ShellBusyError)) throw error;
    res
      .status(503)
      .setHeader("Retry-After", "5")
      .type("text/plain")
      .send(
        "Every shell on this server is busy. Try again in a few seconds.\n",
      );
    return;
  }
  track(req, Boolean(authorization), { command, result });

  res.setHeader("X-Exit-Code", String(result.exitCode));
  res.setHeader("X-Duration-Ms", String(result.durationMs));
  if (req.query.format === "json" || req.accepts(["text", "json"]) === "json") {
    const { stdout, stderr, exitCode, durationMs, truncated } = result;
    res.json({ stdout, stderr, exitCode, durationMs, truncated });
    return;
  }
  let body = result.stdout;
  if (result.stderr) {
    body += (body && !body.endsWith("\n") ? "\n" : "") + result.stderr;
  }
  if (result.exitCode !== 0) {
    body += `${body && !body.endsWith("\n") ? "\n" : ""}[exit ${result.exitCode}]\n`;
  }
  res.type("text/plain").send(body);
}

/**
 * Hosted bash for agents: one command per request, in a fresh sandboxed shell.
 * Registered ahead of the global body parsers so the body is read once, as
 * text, under this route's own size limit.
 */
export function registerHostedBashRoute(
  app: Pick<Application, "get" | "post" | "options">,
) {
  const allowCors = cors({
    exposedHeaders: ["X-Exit-Code", "X-Duration-Ms", "Retry-After"],
  });
  const rateLimit = createRateLimit();
  app.options(ROUTE, allowCors);
  app.get(ROUTE, allowCors, rateLimit, bashController);
  app.post(
    ROUTE,
    allowCors,
    rateLimit,
    express.text({ type: () => true, limit: MAX_COMMAND_BYTES }),
    bashController,
  );
}
