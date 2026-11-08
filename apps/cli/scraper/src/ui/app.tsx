import { existsSync } from "node:fs";
import { join } from "node:path";
import { render, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { checkoutRoot } from "../archive/paths.js";
import type { Config } from "../config.js";
import { resolveUserPath } from "../lib/paths.js";
import { resolveWhisper, whisperStatus } from "../transcribe/setup.js";
import { checkCdp, chromeLaunch, CHROME_PROFILE, startChrome } from "./chrome.js";
import { Dashboard, DashboardReporter, DashboardStore } from "./dashboard.js";
import { executePlan, storeFor, type ExecuteDeps } from "./execute.js";
import { listRuns } from "./runs.js";
import { Wizard, type RunPlan, type WizardDeps } from "./wizard.js";

/** Real machine access for the wizard. */
export function wizardDeps(config: Config): WizardDeps {
  const dataDir = join(checkoutRoot(), "data");
  return {
    defaultCdpUrl: config.cdp?.url ?? "http://localhost:9222",
    defaultOut: dataDir,
    checkCdp: (url) => checkCdp(url),
    chromeStartHint: (url) =>
      chromeLaunch(url) ? `profile ${CHROME_PROFILE}; stays open after the run` : undefined,
    startChrome: (url) => startChrome(url),
    whisper: () => whisperStatus(resolveWhisper(config)),
    listRuns: () => listRuns(dataDir),
    pathExists: (p) => existsSync(resolveUserPath(p)),
  };
}

export function App({
  config,
  deps,
  execute,
}: {
  config: Config;
  deps: WizardDeps;
  execute?: ExecuteDeps | undefined;
}) {
  const { exit } = useApp();
  const [run, setRun] = useState<{ plan: RunPlan; store: DashboardStore }>();
  const controller = useRef(new AbortController());

  // Raw mode turns Ctrl+C into a key press: quit the wizard, or stop the run cleanly.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (run) controller.current.abort();
    else exit(130);
  });

  useEffect(() => {
    if (!run) return;
    void executePlan(run.plan, config, run.store, controller.current.signal, execute).then(
      (code) => {
        exit(code);
      },
    );
  }, [run, config, execute, exit]);

  if (!run)
    return <Wizard deps={deps} onDone={(plan) => setRun({ plan, store: storeFor(plan) })} />;
  return <Dashboard store={run.store} />;
}

/** The interactive entry point: pick everything in the wizard, then watch the run. */
export async function runUi(config: Config): Promise<number> {
  const instance = render(<App config={config} deps={wizardDeps(config)} />, {
    exitOnCtrlC: false,
  });
  const code = (await instance.waitUntilExit()) as number | undefined;
  return code ?? 0;
}

/** The live dashboard for flag-driven runs on a terminal. */
export function startDashboard(
  title: string,
  workers: number,
): { store: DashboardStore; reporter: DashboardReporter; stop: () => Promise<void> } {
  const store = new DashboardStore(title, workers);
  const instance = render(<Dashboard store={store} />, { exitOnCtrlC: false });
  return {
    store,
    reporter: new DashboardReporter(store),
    stop: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
