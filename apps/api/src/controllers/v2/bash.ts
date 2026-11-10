import cors from "cors";
import express, {
  type Application,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { isIPv4 } from "net";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { config } from "../../config";
import {
  MAX_FIRECRAWL_CALLS,
  MAX_OUTPUT_BYTES,
  TIMEOUT_MS,
  runShell,
  type ShellResult,
} from "../../lib/hosted-bash/shell";
import { keylessTeamId, keylessTeamUuid } from "../../lib/keyless-team";
import { logger } from "../../lib/logger";
import { capturePostHog } from "../../services/posthog-capture";

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

function requireEnabled(_req: Request, _res: Response, next: NextFunction) {
  // Off, the path falls through to the API's regular 404.
  next(config.HOSTED_BASH_ENABLED ? undefined : "route");
}

/**
 * Sheds load from one caller on this replica. The real quota is the keyless
 * tier or the caller's plan, enforced on each Firecrawl call the shell makes.
 */
function createRateLimit(): RequestHandler {
  const limiter = new RateLimiterMemory({
    points: COMMANDS_PER_MINUTE,
    duration: 60,
  });
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
  if (typeof req.body !== "string" || !req.body.trim()) return fromQuery;
  // curl --data-binary labels a raw command as a form, so only JSON is parsed.
  if (!req.is("application/json")) return req.body;
  try {
    const command = JSON.parse(req.body)?.command;
    return typeof command === "string" ? command : null;
  } catch {
    return null;
  }
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
  // The id keyless_prompt_shown uses, so runs join to prompts and signups.
  const keylessTeam = isIPv4(ip) ? keylessTeamUuid(keylessTeamId(ip)) : null;
  const event = run ? RUN_EVENT : USAGE_EVENT;
  const properties = {
    keyless_team_id: keylessTeam,
    user_agent: req.get("user-agent")?.slice(0, 300) ?? null,
    method: req.method,
    own_key: ownKey,
    ...(run
      ? {
          subcommands: [
            ...run.command.matchAll(/\bfirecrawl\s+([a-z][\w-]*)/g),
          ].map(match => (CLI_COMMANDS.has(match[1]) ? match[1] : "other")),
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
  const sent = readCommand(req);
  const apiKey =
    /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1] ?? null;

  if (sent === null) {
    res
      .status(400)
      .type("text/plain")
      .send('Send JSON as {"command": "..."}, or the command as the body.\n');
    return;
  }
  const command = sent?.trim();
  if (!command) {
    track(req, Boolean(apiKey));
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

  const result = await runShell(command, {
    baseUrl: ownBaseUrl(req),
    ip: req.ip ?? null,
    apiKey,
  });
  track(req, Boolean(apiKey), { command, result });

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
  if (result.exitCode !== 0) body += `[exit ${result.exitCode}]\n`;
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
    exposedHeaders: ["X-Exit-Code", "X-Duration-Ms"],
  });
  const rateLimit = createRateLimit();
  app.options(ROUTE, requireEnabled, allowCors);
  app.get(ROUTE, requireEnabled, allowCors, rateLimit, bashController);
  app.post(
    ROUTE,
    requireEnabled,
    allowCors,
    rateLimit,
    express.text({ type: () => true, limit: MAX_COMMAND_BYTES }),
    bashController,
  );
}
