import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepEvent } from "../lib/progress.js";
import type { RunProcessOptions } from "../lib/run-process.js";
const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }));
vi.mock("../lib/run-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/run-process.js")>()),
  runProcess,
}));
import { ProcessError } from "../lib/run-process.js";
import { ensureApiReady } from "./local-api.js";
const fetchMock = vi.fn();

beforeEach(() => {
  runProcess.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local API startup", () => {
  it("reuses a healthy API without starting services", async () => {
    fetchMock.mockResolvedValue(new Response("healthy"));
    await ensureApiReady("http://localhost:3002");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("starts Compose for an unavailable local API, reporting its output as events", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValue(new Response("healthy"));
    runProcess.mockImplementation(
      async (_command: string, _args: string[], opts: RunProcessOptions) => {
        opts.onLine?.(" Container firecrawl-api-1  Started", "stderr");
      },
    );
    const controller = new AbortController();
    const events: StepEvent[] = [];
    await ensureApiReady("http://localhost:3002", controller.signal, (e) => events.push(e));

    expect(runProcess).toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "--build", "-d"],
      expect.objectContaining({
        cwd: expect.any(String),
        env: expect.objectContaining({ PORT: "3002" }),
        signal: controller.signal,
      }),
    );
    expect(events).toEqual([
      { type: "step", label: "Local API unavailable; starting Docker Compose…" },
      { type: "log", line: " Container firecrawl-api-1  Started" },
      {
        type: "step",
        label: "Docker services started and will remain running. Stop them with task down.",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not start local services for remote endpoints or unhealthy HTTP responses", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(ensureApiReady("https://remote.example")).rejects.toThrow(
      /automatic startup only/,
    );
    fetchMock.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    await expect(ensureApiReady("http://localhost:3002")).rejects.toThrow(/503/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("reports Docker startup failures with Compose's last output", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection refused"));
    runProcess.mockRejectedValueOnce(
      new ProcessError("docker", 1, "Cannot connect to the Docker daemon"),
    );
    await expect(ensureApiReady("http://localhost:3002")).rejects.toThrow(
      "docker exited with 1: Cannot connect to the Docker daemon",
    );
    runProcess.mockRejectedValueOnce(new Error("docker not found"));
    await expect(ensureApiReady("http://localhost:3002")).rejects.toThrow("docker not found");
  });
});
