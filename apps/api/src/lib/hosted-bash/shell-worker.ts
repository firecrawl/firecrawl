import { Bash, type CommandName, type InitialFiles } from "just-bash";
import {
  FIRECRAWL_HELP,
  FirecrawlClient,
  firecrawlCommand,
  type FirecrawlCaller,
} from "./firecrawl-command";
import { MAX_OUTPUT_BYTES } from "./limits";

/** What the API process hands the shell process: a command, its caller and the docs pages to mount. */
export interface ShellJob {
  command: string;
  caller: FirecrawlCaller;
  docs: string[];
  deadline: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** Firecrawl endpoints the command called, and the ones that failed. */
  endpoints: string[];
  failedEndpoints: string[];
}

export type WorkerMessage =
  | { type: "doc"; id: number; path: string }
  | { type: "done"; result: SandboxResult };

export type ParentMessage =
  | { type: "job"; job: ShellJob }
  | { type: "doc"; id: number; text?: string; error?: string };

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

function truncate(text: string): [string, boolean] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return [text, false];
  const kept = bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return [`${kept}\n[truncated at ${MAX_OUTPUT_BYTES} bytes]\n`, true];
}

const send = (message: WorkerMessage) => process.send?.(message);

// Docs pages are read through the API process, which caches them for every shell.
const pending = new Map<
  number,
  { resolve: (text: string) => void; reject: (error: Error) => void }
>();
let nextId = 0;
process.on("message", (message: ParentMessage) => {
  if (message.type === "job") {
    void run(message.job)
      .catch(
        (error: unknown): SandboxResult => ({
          stdout: "",
          stderr: `bash: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
          truncated: false,
          endpoints: [],
          failedEndpoints: [],
        }),
      )
      .then(result => send({ type: "done", result }));
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error === undefined) waiter.resolve(message.text ?? "");
  else waiter.reject(new Error(message.error));
});
const readDoc = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ type: "doc", id, path });
  });

async function run(job: ShellJob): Promise<SandboxResult> {
  const client = new FirecrawlClient(job.caller);
  const files: InitialFiles = { "/README.md": README };
  for (const path of job.docs) files[path] = () => readDoc(path);
  const bash = new Bash({
    files,
    cwd: "/",
    env: { HOME: "/", PWD: "/" },
    commands: COMMANDS,
    customCommands: [firecrawlCommand(client)],
    executionLimitProfile: "hardened",
    // The API process also kills this process at the deadline, since a single
    // long command never reaches just-bash's own check.
    executionLimits: {
      maxExecutionTimeMs: Math.max(1, job.deadline - Date.now()),
      maxFileSystemBytes: 32 * MIB,
      maxStringLength: MIB,
      maxHeredocSize: MIB,
      maxOutputSize: 2 * MIB,
      maxLiveBytes: 64 * MIB,
      maxInputBytes: 32 * MIB,
    },
  });
  const outcome = await bash.exec(job.command).catch((error: unknown) => ({
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
    truncated: stdoutCut || stderrCut,
    endpoints: client.endpoints,
    failedEndpoints: client.failedEndpoints,
  };
}
