import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpCheck } from "./chrome.js";
import { Wizard, type RunPlan, type WizardDeps } from "./wizard.js";

const ENTER = "\r";
const ESC = "\u001B";
const DOWN = "\u001B[B";
const BACKSPACE = "\u007F";
const SPACE = " ";

function deps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    defaultCdpUrl: "http://localhost:9222",
    defaultOut: "/data",
    checkCdp: async () => ({ ok: true, browser: "Chrome/141" }),
    chromeStartHint: () => "profile ~/.scraper-chrome",
    startChrome: async () => ({ ok: true, browser: "Chrome/141" }),
    whisper: () => ({
      bin: "/w/whisper-cli",
      model: "/w/model.bin",
      binFound: true,
      modelFound: true,
      ready: true,
    }),
    listRuns: async () => [],
    pathExists: () => true,
    ...overrides,
  };
}

/** Render the wizard and type keys one at a time, letting Ink re-render between them. */
function setup(d: WizardDeps) {
  const onDone = vi.fn<(plan: RunPlan) => void>();
  const ui = render(<Wizard deps={d} onDone={onDone} />);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) {
      ui.stdin.write(key);
      // oxlint-disable-next-line no-await-in-loop -- each key needs its own render
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const frame = (): string => ui.lastFrame() ?? "";
  /** Wait for a screen reached asynchronously; its key handlers attach just after it draws. */
  const until = async (text: string): Promise<void> => {
    await vi.waitFor(() => expect(frame()).toContain(text), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  return { ui, press, frame, until, onDone };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wizard", () => {
  it("collects an archive run through Chrome with transcription", async () => {
    const notReady = deps({
      whisper: () => ({
        bin: "/w/whisper-cli",
        model: "/w/model.bin",
        binFound: false,
        modelFound: false,
        ready: false,
      }),
    });
    const { press, frame, until, onDone } = setup(notReady);
    expect(frame()).toContain("What do you want to do?");

    await press(ENTER); // Archive a site
    await press("example.com", ENTER);
    expect(frame()).toContain("Chrome via CDP (your logged-in browser)");
    await press(ENTER); // CDP
    await press(ENTER); // default CDP URL, then the live check connects
    await until("Click Play buttons");
    expect(frame()).toContain("Chrome/141");
    await press(DOWN, ENTER); // play media: yes
    await press(BACKSPACE, BACKSPACE, BACKSPACE, "5", ENTER); // limit 5
    await press(ENTER); // delay 1000
    await press(SPACE, ENTER); // untick images
    await press(ENTER); // max 100 MB
    await press(ENTER); // transcribe: yes
    await press(DOWN, ENTER); // 3 workers
    await press(ENTER); // language auto
    expect(frame()).toContain("Transcription is not set up");
    await press(ENTER); // set it up first
    await press(ENTER); // output /data
    expect(frame()).toContain("Review");
    expect(frame()).toContain("3 workers, language auto");
    expect(frame()).toContain("install whisper.cpp first");

    await press(ENTER);
    expect(onDone).toHaveBeenCalledWith({
      kind: "archive",
      url: "https://example.com/",
      engine: "cdp",
      cdpUrl: "http://localhost:9222",
      playMedia: true,
      limit: 5,
      delayMs: 1000,
      media: ["video", "audio"],
      maxMediaMb: 100,
      transcribe: { workers: 3, language: "auto", model: undefined, cpu: false },
      out: "/data",
      setupFirst: true,
    });
  });

  it("offers to start Chrome when nothing answers on the CDP port", async () => {
    const checks: CdpCheck[] = [{ ok: false, error: "ECONNREFUSED" }];
    const startChrome = vi.fn(async () => ({ ok: true, browser: "Chrome/141" }));
    const { press, frame, until } = setup(
      deps({ checkCdp: async () => checks.shift() ?? { ok: true }, startChrome }),
    );
    await press(ENTER, "example.com", ENTER, ENTER, ENTER);
    await until("No Chrome answered at http://localhost:9222 (ECONNREFUSED)");
    expect(frame()).toContain("Start a dedicated Chrome on this port");

    await press(ENTER);
    await until("Click Play buttons");
    expect(startChrome).toHaveBeenCalledWith("http://localhost:9222");
  });

  it("can switch to the Firecrawl API when Chrome is unavailable", async () => {
    const { press, frame, until, onDone } = setup(
      deps({ checkCdp: async () => ({ ok: false, error: "ECONNREFUSED" }) }),
    );
    await press(ENTER, "example.com", ENTER, ENTER, ENTER);
    await until("No Chrome answered");
    await press(DOWN, DOWN, ENTER); // Use the Firecrawl API instead
    expect(frame()).toContain("Maximum pages to visit");
    await press(ENTER, ENTER, ENTER, ENTER, DOWN, ENTER, ENTER, ENTER); // ..., transcribe: no
    expect(frame()).toContain("Firecrawl API");
    await press(ENTER);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "api", cdpUrl: undefined, transcribe: undefined }),
    );
  });

  it("goes back with Esc and keeps earlier answers", async () => {
    const { press, frame } = setup(deps());
    await press(ENTER, "example.com", ENTER);
    expect(frame()).toContain("Which engine");
    await press(ESC);
    expect(frame()).toContain("Which site should be archived?");
    expect(frame()).toContain("https://example.com/");
  });

  it("rejects an invalid URL and stays on the step", async () => {
    const { press, frame } = setup(deps());
    await press(ENTER, "ftp://nope", ENTER);
    expect(frame()).toContain("Enter an http(s) URL");
    expect(frame()).toContain("Which site should be archived?");
  });

  it("transcribes a past archive run", async () => {
    const { press, frame, until, onDone } = setup(
      deps({
        listRuns: async () => [
          {
            dir: "/data/example.com/run-1",
            sourceUrl: "https://example.com/",
            startedAt: "2026-11-08T10:00:00.000Z",
            media: 4,
            transcribed: 1,
          },
        ],
      }),
    );
    await press(DOWN, ENTER); // Transcribe existing files
    await until("example.com · 2026-11-08 10:00");
    expect(frame()).toContain("4 audio/video, 1 transcribed");
    await press(ENTER, ENTER, ENTER); // the run, 2 workers, auto
    expect(frame()).toContain("Review");
    await press(ENTER);
    expect(onDone).toHaveBeenCalledWith({
      kind: "transcribe",
      inputs: ["/data/example.com/run-1"],
      choices: { workers: 2, language: "auto", model: undefined, cpu: false },
      setupFirst: false,
    });
  });

  it("starts setup from the first screen", async () => {
    const { press, frame, onDone } = setup(deps());
    await press(DOWN, DOWN, ENTER);
    expect(frame()).toContain("whisper-cli: found (/w/whisper-cli)");
    await press(ENTER);
    expect(onDone).toHaveBeenCalledWith({ kind: "setup" });
  });
});
