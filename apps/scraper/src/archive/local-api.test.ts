import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { ensureApiReady } from "./local-api.js";
const fetchMock = vi.fn();

beforeEach(() => {
  spawn.mockReset();
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
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts Compose only for an unavailable local API and waits for readiness", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValue(new Response("healthy"));
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await ensureApiReady("http://localhost:3002");
    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "--build", "-d"],
      expect.objectContaining({ env: expect.objectContaining({ PORT: "3002" }) }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not start local services for remote endpoints or unhealthy HTTP responses", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(ensureApiReady("https://remote.example")).rejects.toThrow(
      /automatic startup only/,
    );
    fetchMock.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    await expect(ensureApiReady("http://localhost:3002")).rejects.toThrow(/503/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports Docker startup failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection refused"));
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("Docker unavailable")));
      return child;
    });
    await expect(ensureApiReady("http://localhost:3002")).rejects.toThrow(/Docker unavailable/);
  });
});
