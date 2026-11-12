import { Bash, type CommandName } from "just-bash";
import { docsFiles } from "./docs";
import {
  FIRECRAWL_HELP,
  FirecrawlClient,
  firecrawlCommand,
  type FirecrawlCaller,
} from "./firecrawl-command";

export const TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 256_000;
export const MAX_FIRECRAWL_CALLS = 25;
const MIB = 1024 * 1024;

// Text tools only: no archives, databases, Python or JavaScript. bash, sh, awk
// and xargs still run commands, under the same execution limits.
const COMMANDS: CommandName[] = [
  "echo",
  "cat",
  "printf",
  "ls",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "pwd",
  "head",
  "tail",
  "wc",
  "stat",
  "grep",
  "fgrep",
  "egrep",
  "rg",
  "sed",
  "awk",
  "sort",
  "uniq",
  "comm",
  "cut",
  "paste",
  "tr",
  "rev",
  "nl",
  "fold",
  "column",
  "join",
  "tee",
  "find",
  "basename",
  "dirname",
  "tree",
  "du",
  "env",
  "xargs",
  "true",
  "false",
  "bash",
  "sh",
  "jq",
  "base64",
  "date",
  "sleep",
  "seq",
  "expr",
  "tac",
  "which",
  "help",
];

const README = `# Firecrawl bash

A stateless virtual shell with a hosted subset of the Firecrawl CLI as \`firecrawl\`.
Each request starts from this fresh filesystem; nothing persists between requests.

  /README.md   this file
  /docs/       the live Firecrawl docs (docs.firecrawl.dev) as markdown, fetched when read.
               Start with /docs/llms.txt, or grep -l -r <term> /docs/features /docs/sdks

${FIRECRAWL_HELP}`;

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  /** Firecrawl endpoints the command called, and the ones that failed. */
  endpoints: string[];
  failedEndpoints: string[];
}

function truncate(text: string): [string, boolean] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return [text, false];
  const kept = bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return [`${kept}\n[truncated at ${MAX_OUTPUT_BYTES} bytes]\n`, true];
}

/** Run one command in a fresh in-memory shell as the given caller. */
export async function runShell(
  command: string,
  caller: Omit<FirecrawlCaller, "maxCalls">,
): Promise<ShellResult> {
  const started = Date.now();
  const client = new FirecrawlClient({
    ...caller,
    maxCalls: MAX_FIRECRAWL_CALLS,
  });
  const bash = new Bash({
    files: { ...(await docsFiles()), "/README.md": README },
    cwd: "/",
    env: { HOME: "/", PWD: "/" },
    commands: COMMANDS,
    customCommands: [firecrawlCommand(client)],
    // Callers are anonymous and commands run inside the API process.
    executionLimitProfile: "hardened",
    // The string and memory caps keep one request from holding hundreds of MB.
    executionLimits: {
      maxExecutionTimeMs: TIMEOUT_MS,
      maxFileSystemBytes: 32 * MIB,
      maxStringLength: MIB,
      maxHeredocSize: MIB,
      maxOutputSize: 2 * MIB,
      maxLiveBytes: 64 * MIB,
      maxInputBytes: 32 * MIB,
    },
  });

  const outcome = await bash.exec(command).catch((error: unknown) => ({
    stdout: "",
    stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    exitCode: 1,
  }));
  const [stdout, stdoutCut] = truncate(outcome.stdout);
  const [stderr, stderrCut] = truncate(outcome.stderr);
  return {
    stdout,
    stderr,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    truncated: stdoutCut || stderrCut,
    endpoints: client.endpoints,
    failedEndpoints: client.failedEndpoints,
  };
}
