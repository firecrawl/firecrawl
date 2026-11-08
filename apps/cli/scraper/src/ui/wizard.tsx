import { MultiSelect, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { MEDIA_KINDS, type MediaKind } from "../commands/archive.js";
import type { TranscribeChoices } from "../commands/transcribe.js";
import type { WhisperStatus } from "../transcribe/setup.js";
import type { CdpCheck } from "./chrome.js";
import type { RunSummary } from "./runs.js";

export type Engine = "cdp" | "api";

export interface ArchiveRunPlan {
  kind: "archive";
  url: string;
  engine: Engine;
  cdpUrl: string | undefined;
  playMedia: boolean;
  limit: number;
  delayMs: number;
  media: MediaKind[];
  maxMediaMb: number;
  transcribe: TranscribeChoices | undefined;
  out: string;
  /** Install whisper.cpp before the run starts. */
  setupFirst: boolean;
}

export interface TranscribeRunPlan {
  kind: "transcribe";
  inputs: string[];
  choices: TranscribeChoices;
  setupFirst: boolean;
}

export type RunPlan = ArchiveRunPlan | TranscribeRunPlan | { kind: "setup" };

/** Everything the wizard needs from the machine, injectable for tests. */
export interface WizardDeps {
  defaultCdpUrl: string;
  defaultOut: string;
  checkCdp(url: string): Promise<CdpCheck>;
  /** Undefined when Chrome cannot be started for this URL. */
  chromeStartHint(url: string): string | undefined;
  startChrome(url: string): Promise<CdpCheck>;
  whisper(): WhisperStatus;
  listRuns(): Promise<RunSummary[]>;
  pathExists(path: string): boolean;
}

type Mode = "archive" | "transcribe" | "setup";

interface Answers {
  mode: Mode;
  url: string;
  engine: Engine;
  cdpUrl: string;
  browser: string | undefined;
  playMedia: boolean;
  limit: number;
  delayMs: number;
  media: MediaKind[];
  maxMediaMb: number;
  transcribe: boolean;
  workers: number;
  language: string;
  setupFirst: boolean;
  out: string;
  inputs: string[];
}

type StepId =
  | "mode"
  | "url"
  | "engine"
  | "cdpUrl"
  | "cdpCheck"
  | "playMedia"
  | "limit"
  | "delay"
  | "media"
  | "maxMediaMb"
  | "transcribe"
  | "source"
  | "path"
  | "workers"
  | "language"
  | "setup"
  | "out"
  | "review"
  | "setupReview";

const hasAudioOrVideo = (media: readonly MediaKind[]): boolean =>
  media.includes("audio") || media.includes("video");

function nextStep(step: StepId, a: Answers, whisperReady: boolean): StepId {
  const afterLanguage = (): StepId => {
    if (!whisperReady) return "setup";
    return a.mode === "archive" ? "out" : "review";
  };
  switch (step) {
    case "mode":
      return a.mode === "archive" ? "url" : a.mode === "transcribe" ? "source" : "setupReview";
    case "url":
      return "engine";
    case "engine":
      return a.engine === "cdp" ? "cdpUrl" : "limit";
    case "cdpUrl":
      return "cdpCheck";
    case "cdpCheck":
      return "playMedia";
    case "playMedia":
      return "limit";
    case "limit":
      return "delay";
    case "delay":
      return "media";
    case "media":
      return a.media.length === 0 ? "out" : "maxMediaMb";
    case "maxMediaMb":
      return hasAudioOrVideo(a.media) ? "transcribe" : "out";
    case "transcribe":
      return a.transcribe ? "workers" : "out";
    case "source":
      return a.inputs.length === 0 ? "path" : "workers";
    case "path":
      return "workers";
    case "workers":
      return "language";
    case "language":
      return afterLanguage();
    case "setup":
      return a.mode === "archive" ? "out" : "review";
    case "out":
      return "review";
    case "review":
    case "setupReview":
      return step;
  }
}

function buildPlan(a: Answers, whisperReady: boolean): RunPlan {
  if (a.mode === "setup") return { kind: "setup" };
  const choices: TranscribeChoices = {
    workers: a.workers,
    language: a.language,
    model: undefined,
    cpu: false,
  };
  if (a.mode === "transcribe")
    return { kind: "transcribe", inputs: a.inputs, choices, setupFirst: !whisperReady };
  const transcribe = a.transcribe && hasAudioOrVideo(a.media) ? choices : undefined;
  return {
    kind: "archive",
    url: a.url,
    engine: a.engine,
    cdpUrl: a.engine === "cdp" ? a.cdpUrl : undefined,
    playMedia: a.engine === "cdp" && a.playMedia,
    limit: a.limit,
    delayMs: a.delayMs,
    media: a.media,
    maxMediaMb: a.maxMediaMb,
    transcribe,
    out: a.out,
    setupFirst: transcribe !== undefined && !whisperReady,
  };
}

const ENGINE_LABELS: Record<Engine, string> = {
  cdp: "Chrome via CDP (your logged-in browser)",
  api: "Firecrawl API",
};

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/** The answer a finished step contributes to the summary and review. */
function describe(step: StepId, a: Answers): [string, string] | undefined {
  switch (step) {
    case "mode":
      return [
        "Task",
        { archive: "Archive a site", transcribe: "Transcribe files", setup: "Set up" }[a.mode],
      ];
    case "url":
      return ["URL", a.url];
    case "engine":
      return ["Engine", ENGINE_LABELS[a.engine]];
    case "cdpUrl":
      return ["CDP URL", a.cdpUrl];
    case "cdpCheck":
      return ["Browser", a.browser ?? "connected"];
    case "playMedia":
      return ["Play media", yesNo(a.playMedia)];
    case "limit":
      return ["Page limit", String(a.limit)];
    case "delay":
      return ["Delay", `${a.delayMs} ms`];
    case "media":
      return ["Media", a.media.length > 0 ? a.media.join(", ") : "none (pages only)"];
    case "maxMediaMb":
      return ["Max media", `${a.maxMediaMb} MB per file`];
    case "transcribe":
      return ["Transcribe", yesNo(a.transcribe)];
    case "source":
    case "path":
      return ["Inputs", a.inputs.join(", ")];
    case "workers":
      return ["Workers", String(a.workers)];
    case "language":
      return ["Language", a.language];
    case "setup":
      return ["Setup", "install whisper.cpp first"];
    case "out":
      return ["Output", a.out];
    case "review":
    case "setupReview":
      return undefined;
  }
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string | undefined;
}

/** ↑/↓ to move, Enter to pick. Unlike @inkjs/ui Select, Enter always submits. */
export function Choice<T extends string>({
  options,
  initial,
  onSelect,
}: {
  options: ReadonlyArray<ChoiceOption<T>>;
  initial?: T | undefined;
  onSelect: (value: T) => void;
}) {
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === initial),
    ),
  );
  useInput((_input, key) => {
    if (key.upArrow) setFocus((f) => (f - 1 + options.length) % options.length);
    if (key.downArrow) setFocus((f) => (f + 1) % options.length);
    if (key.return) onSelect(options[focus]!.value);
  });
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Box key={o.value} gap={1}>
          <Text {...(i === focus ? { color: "cyan" } : {})}>
            {i === focus ? "❯" : " "} {o.label}
          </Text>
          {o.hint && <Text dimColor>{o.hint}</Text>}
        </Box>
      ))}
    </Box>
  );
}

type Parsed<T> = { value: T } | { error: string };

function TextStep<T>({
  initial,
  parse,
  onSubmit,
  suggestions,
}: {
  initial: string;
  parse: (raw: string) => Parsed<T>;
  onSubmit: (value: T) => void;
  suggestions?: string[] | undefined;
}) {
  const [error, setError] = useState<string>();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">❯ </Text>
        <TextInput
          defaultValue={initial}
          {...(suggestions ? { suggestions } : {})}
          onSubmit={(raw) => {
            const parsed = parse(raw.trim());
            if ("error" in parsed) setError(parsed.error);
            else onSubmit(parsed.value);
          }}
        />
      </Box>
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}

const wholeNumber =
  (min: number, what: string) =>
  (raw: string): Parsed<number> => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= min
      ? { value: n }
      : { error: `${what} must be a whole number of at least ${min}` };
  };

function parseUrl(raw: string): Parsed<string> {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!raw || (url.protocol !== "http:" && url.protocol !== "https:"))
      return { error: "Enter an http(s) URL" };
    return { value: url.href };
  } catch {
    return { error: "Enter an http(s) URL" };
  }
}

const LANGUAGES = ["auto", "en", "id", "ja", "zh", "ko", "es", "fr", "de", "pt", "ru", "ar", "hi"];

function CdpCheckStep({
  url,
  deps,
  onConnected,
  onUseApi,
}: {
  url: string;
  deps: WizardDeps;
  onConnected: (browser: string | undefined) => void;
  onUseApi: () => void;
}) {
  const [state, setState] = useState<{ phase: "checking" | "starting" | "failed"; error?: string }>(
    { phase: "checking" },
  );
  const [attempt, setAttempt] = useState(0);
  // The parent passes a fresh callback each render; checks should not restart because of it.
  const connected = useRef(onConnected);
  connected.current = onConnected;

  useEffect(() => {
    if (state.phase === "failed") return;
    let live = true;
    const check = state.phase === "starting" ? deps.startChrome(url) : deps.checkCdp(url);
    void check.then((result) => {
      if (!live) return;
      if (result.ok) connected.current(result.browser);
      else setState({ phase: "failed", error: result.error ?? "no answer" });
    });
    return () => {
      live = false;
    };
  }, [attempt, state.phase, url, deps]);

  if (state.phase !== "failed")
    return (
      <Spinner
        label={state.phase === "starting" ? "Starting Chrome…" : `Checking for Chrome at ${url}…`}
      />
    );
  const startHint = deps.chromeStartHint(url);
  const retry = (phase: "checking" | "starting"): void => {
    setState({ phase });
    setAttempt((n) => n + 1);
  };
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="yellow">
        No Chrome answered at {url} ({state.error}).
      </Text>
      <Choice
        key={attempt}
        options={[
          ...(startHint
            ? [
                {
                  value: "start" as const,
                  label: "Start a dedicated Chrome on this port",
                  hint: startHint,
                },
              ]
            : []),
          { value: "retry" as const, label: "Check again" },
          { value: "api" as const, label: "Use the Firecrawl API instead" },
        ]}
        onSelect={(choice) => {
          if (choice === "api") onUseApi();
          else retry(choice === "start" ? "starting" : "checking");
        }}
      />
    </Box>
  );
}

function SourceStep({ deps, onPick }: { deps: WizardDeps; onPick: (inputs: string[]) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>();
  useEffect(() => {
    let live = true;
    void deps
      .listRuns()
      .catch(() => [])
      .then((found) => {
        if (live) setRuns(found);
      });
    return () => {
      live = false;
    };
  }, [deps]);
  if (!runs) return <Spinner label="Looking for past archive runs…" />;
  return (
    <Choice
      options={[
        ...runs.map((r) => ({
          value: r.dir,
          label: `${new URL(r.sourceUrl).host} · ${r.startedAt.slice(0, 16).replace("T", " ")}`,
          hint: `${r.media} audio/video, ${r.transcribed} transcribed`,
        })),
        { value: "", label: "Type a path to a file or folder…" },
      ]}
      onSelect={(dir) => onPick(dir ? [dir] : [])}
    />
  );
}

const QUESTIONS: Record<StepId, string> = {
  mode: "What do you want to do?",
  url: "Which site should be archived?",
  engine: "Which engine should load the pages?",
  cdpUrl: "Chrome DevTools URL",
  cdpCheck: "Connecting to Chrome",
  playMedia: "Click Play buttons so on-demand audio/video loads?",
  limit: "Maximum pages to visit",
  delay: "Delay between pages (ms)",
  media: "Which media should be downloaded? (space toggles, Enter continues)",
  maxMediaMb: "Largest media file to download (MB)",
  transcribe: "Transcribe downloaded audio and video to text with timestamps?",
  source: "What should be transcribed?",
  path: "Path to a media file, a folder, or an archive run",
  workers: "How many transcription workers should run at once?",
  language: "Spoken language (code, or auto to detect)",
  setup: "Transcription is not set up on this machine yet",
  out: "Where should the archive be saved?",
  review: "Review",
  setupReview: "Set up transcription",
};

export function Wizard({ deps, onDone }: { deps: WizardDeps; onDone: (plan: RunPlan) => void }) {
  const [step, setStep] = useState<StepId>("mode");
  const [history, setHistory] = useState<StepId[]>([]);
  const [a, setAnswers] = useState<Answers>(() => ({
    mode: "archive",
    url: "",
    engine: "cdp",
    cdpUrl: deps.defaultCdpUrl,
    browser: undefined,
    playMedia: false,
    limit: 100,
    delayMs: 1000,
    media: [...MEDIA_KINDS],
    maxMediaMb: 100,
    transcribe: true,
    workers: 2,
    language: "auto",
    setupFirst: false,
    out: deps.defaultOut,
    inputs: [],
  }));
  const [whisper] = useState(() => deps.whisper());

  const answer = (patch: Partial<Answers>): void => {
    const next = { ...a, ...patch };
    setAnswers(next);
    setHistory((h) => [...h, step]);
    setStep(nextStep(step, next, whisper.ready));
  };

  useInput((_input, key) => {
    if (!key.escape || history.length === 0) return;
    setStep(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
  });

  const plan = buildPlan(a, whisper.ready);
  useInput(
    (_input, key) => {
      if (key.return) onDone(plan);
    },
    { isActive: step === "review" || step === "setupReview" },
  );

  const summary = history.map((s) => describe(s, a)).filter((d) => d !== undefined);
  const deduped = [...new Map(summary.map(([label, value]) => [label, value])).entries()];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>firescrape scraper</Text>
      <Box flexDirection="column" marginY={1}>
        {deduped.map(([label, value]) => (
          <Box key={label}>
            <Box width={13} flexShrink={0}>
              <Text dimColor>{label}</Text>
            </Box>
            <Text>{value}</Text>
          </Box>
        ))}
      </Box>
      <Text bold color="cyan">
        {QUESTIONS[step]}
      </Text>
      <Box key={step} marginTop={1}>
        {renderStep()}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {step === "review" || step === "setupReview" ? "Enter to start · " : ""}
          {history.length > 0 ? "Esc to go back · " : ""}Ctrl+C to quit
        </Text>
      </Box>
    </Box>
  );

  function renderStep() {
    switch (step) {
      case "mode":
        return (
          <Choice
            initial={a.mode}
            options={[
              { value: "archive", label: "Archive a site", hint: "pages, media, transcripts" },
              {
                value: "transcribe",
                label: "Transcribe existing files",
                hint: "a past run or media files",
              },
              {
                value: "setup",
                label: "Set up transcription",
                hint: whisper.ready ? "installed" : "not installed yet",
              },
            ]}
            onSelect={(mode) => answer({ mode })}
          />
        );
      case "url":
        return (
          <TextStep
            key={step}
            initial={a.url}
            parse={parseUrl}
            onSubmit={(url) => answer({ url })}
          />
        );
      case "engine":
        return (
          <Choice
            initial={a.engine}
            options={[
              { value: "cdp", label: ENGINE_LABELS.cdp, hint: "uses your sessions and cookies" },
              { value: "api", label: ENGINE_LABELS.api, hint: "self-hosted Firecrawl" },
            ]}
            onSelect={(engine) => answer({ engine })}
          />
        );
      case "cdpUrl":
        return (
          <TextStep
            key={step}
            initial={a.cdpUrl}
            parse={(raw) => {
              const parsed = parseUrl(raw.includes("://") ? raw : `http://${raw}`);
              return "error" in parsed ? parsed : { value: parsed.value.replace(/\/$/, "") };
            }}
            onSubmit={(cdpUrl) => answer({ cdpUrl })}
          />
        );
      case "cdpCheck":
        return (
          <CdpCheckStep
            url={a.cdpUrl}
            deps={deps}
            onConnected={(browser) => answer({ browser })}
            onUseApi={() => {
              setAnswers({ ...a, engine: "api" });
              setHistory((h) => [...h.filter((s) => s !== "cdpUrl"), "engine"]);
              setStep("limit");
            }}
          />
        );
      case "playMedia":
        return (
          <Choice
            initial={a.playMedia ? "yes" : "no"}
            options={[
              { value: "no", label: "No" },
              {
                value: "yes",
                label: "Yes",
                hint: "clicks Play/Listen controls; audio may be heard",
              },
            ]}
            onSelect={(v) => answer({ playMedia: v === "yes" })}
          />
        );
      case "limit":
        return (
          <TextStep
            key={step}
            initial={String(a.limit)}
            parse={wholeNumber(1, "The page limit")}
            onSubmit={(limit) => answer({ limit })}
          />
        );
      case "delay":
        return (
          <TextStep
            key={step}
            initial={String(a.delayMs)}
            parse={wholeNumber(0, "The delay")}
            onSubmit={(delayMs) => answer({ delayMs })}
          />
        );
      case "media":
        return (
          <MultiSelect
            defaultValue={a.media}
            options={MEDIA_KINDS.map((kind) => ({
              value: kind,
              label: { image: "Images", video: "Video", audio: "Audio" }[kind],
            }))}
            onSubmit={(media) =>
              answer({ media: MEDIA_KINDS.filter((kind) => media.includes(kind)) })
            }
          />
        );
      case "maxMediaMb":
        return (
          <TextStep
            key={step}
            initial={String(a.maxMediaMb)}
            parse={wholeNumber(1, "The size")}
            onSubmit={(maxMediaMb) => answer({ maxMediaMb })}
          />
        );
      case "transcribe":
        return (
          <Choice
            initial={a.transcribe ? "yes" : "no"}
            options={[
              {
                value: "yes",
                label: "Yes",
                hint: "SRT, VTT, JSON and timestamped text while the crawl runs",
              },
              { value: "no", label: "No" },
            ]}
            onSelect={(v) => answer({ transcribe: v === "yes" })}
          />
        );
      case "source":
        return <SourceStep deps={deps} onPick={(inputs) => answer({ inputs })} />;
      case "path":
        return (
          <TextStep
            key={step}
            initial={a.inputs[0] ?? ""}
            parse={(raw) =>
              raw && deps.pathExists(raw)
                ? { value: raw }
                : { error: `Not found: ${raw || "(empty)"}` }
            }
            onSubmit={(path) => answer({ inputs: [path] })}
          />
        );
      case "workers":
        return (
          <Choice
            initial={String(a.workers)}
            options={["1", "2", "3", "4"].map((n) => ({
              value: n,
              label: n,
              hint: n === "2" ? "each loads its own model, about 1 GB of GPU memory" : undefined,
            }))}
            onSelect={(n) => answer({ workers: Number(n) })}
          />
        );
      case "language":
        return (
          <TextStep
            key={step}
            initial={a.language}
            suggestions={LANGUAGES}
            parse={(raw) =>
              /^(?:auto|[a-z]{2,3})$/.test(raw)
                ? { value: raw }
                : { error: "Use a language code such as en or id, or auto" }
            }
            onSubmit={(language) => answer({ language })}
          />
        );
      case "setup":
        return (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>
              Needs git, cmake and a C++ compiler. Builds whisper.cpp (CUDA when nvcc is present)
              and downloads a 550 MB model; takes a few minutes the first time.
            </Text>
            <Choice
              options={[
                { value: "setup", label: "Set it up before the run starts" },
                ...(a.mode === "archive"
                  ? [{ value: "off", label: "Turn transcription off" }]
                  : []),
              ]}
              onSelect={(v) =>
                v === "setup" ? answer({ setupFirst: true }) : answer({ transcribe: false })
              }
            />
          </Box>
        );
      case "out":
        return (
          <TextStep
            key={step}
            initial={a.out}
            parse={(raw) => (raw ? { value: raw } : { error: "Enter a directory" })}
            onSubmit={(out) => answer({ out })}
          />
        );
      case "review":
        return <Review plan={plan} />;
      case "setupReview":
        return (
          <Box flexDirection="column">
            <Text>
              whisper-cli: {whisper.binFound ? "found" : "missing"} ({whisper.bin})
            </Text>
            <Text>
              model: {whisper.modelFound ? "found" : "missing"} ({whisper.model})
            </Text>
            <Text dimColor>
              {whisper.ready
                ? "Already set up; this updates and rebuilds whisper.cpp if needed."
                : "Builds whisper.cpp and downloads the model; takes a few minutes."}
            </Text>
          </Box>
        );
    }
  }
}

function Review({ plan }: { plan: RunPlan }) {
  const rows: Array<[string, string]> =
    plan.kind === "archive"
      ? [
          ["URL", plan.url],
          ["Engine", ENGINE_LABELS[plan.engine] + (plan.cdpUrl ? ` at ${plan.cdpUrl}` : "")],
          ...(plan.engine === "cdp"
            ? [["Play media", yesNo(plan.playMedia)] as [string, string]]
            : []),
          ["Pages", `up to ${plan.limit}, ${plan.delayMs} ms apart`],
          [
            "Media",
            plan.media.length > 0
              ? `${plan.media.join(", ")} up to ${plan.maxMediaMb} MB each`
              : "none",
          ],
          [
            "Transcribe",
            plan.transcribe
              ? `${plan.transcribe.workers} workers, language ${plan.transcribe.language}`
              : "no",
          ],
          ...(plan.setupFirst ? [["Setup", "install whisper.cpp first"] as [string, string]] : []),
          ["Output", plan.out],
        ]
      : plan.kind === "transcribe"
        ? [
            ["Inputs", plan.inputs.join(", ")],
            ["Workers", String(plan.choices.workers)],
            ["Language", plan.choices.language],
            ...(plan.setupFirst
              ? [["Setup", "install whisper.cpp first"] as [string, string]]
              : []),
          ]
        : [];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Box width={13} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Text>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}
