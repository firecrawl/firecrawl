import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firebillCheck } from "../firebill";
import { logger } from "../../../lib/logger";

const { configState } = vi.hoisted(() => ({
  configState: {
    FIREBILL_URL: "",
    FIREBILL_SECRET: "secret",
    FIRECRAWL_BUILD_SHA: undefined as string | undefined,
  },
}));

vi.mock("../../../config", () => ({ config: configState }));
vi.mock("../../queue-service", () => ({
  getFirebillTrackRetryQueue: () => ({ add: vi.fn() }),
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Real sockets against a local server, one per test so each starts with no
// pooled connection: what is under test is what undici actually did.
const servers: http.Server[] = [];
let connections = 0;

async function serve(handler: http.RequestListener): Promise<void> {
  const server = http.createServer(handler);
  // Like firebill, send no Keep-Alive hint: undici would take the hint over
  // its own idle timeout.
  server.keepAliveTimeout = 0;
  server.on("connection", () => connections++);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  configState.FIREBILL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const answer: http.RequestListener = (req, res) => {
  req.resume();
  req.on("end", () =>
    res.end(JSON.stringify({ success: true, allowed: true, remaining: 10 })),
  );
};

const check = () =>
  firebillCheck({
    customerId: "org-1",
    entityId: "team-1",
    featureId: "CREDITS",
    value: 1,
  });

/** The fields of the "did not complete" log line, which every failure here hits. */
function failureLog(): Record<string, unknown> {
  const calls = vi.mocked(logger.error).mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][];
  const line = calls.find(([message]) => message.includes("did not complete"));
  expect(line).toBeDefined();
  return line![1];
}

function blockEventLoop(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

afterEach(async () => {
  vi.mocked(logger.error).mockClear();
  connections = 0;
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

describe("firebill transport", () => {
  it("keeps a connection open across a gap the default pool would close it in", async () => {
    await serve(answer);

    expect(await check()).toMatchObject({ status: "answered" });
    // undici's default keep-alive is 4s.
    await new Promise(resolve => setTimeout(resolve, 4_500));
    expect(await check()).toMatchObject({ status: "answered" });

    expect(connections).toBe(1);
  }, 15_000);

  it("says when the failed call opened its own connection", async () => {
    await serve(req => req.socket.destroy());

    expect(await check()).toEqual({ status: "unavailable" });

    expect(failureLog()).toMatchObject({
      cause: "connection",
      newConnection: true,
      connectMs: expect.any(Number),
      elapsedMs: expect.any(Number),
      eventLoopBusyMs: expect.any(Number),
    });
  });

  it("tells a stalled event loop from a slow answer", async () => {
    await serve(answer);
    expect(await check()).toMatchObject({ status: "answered" });
    // The socket goes back to the pool a tick after the body is read.
    await new Promise(resolve => setTimeout(resolve, 100));

    // Firebill answers at once; the loop is blocked past the 5s deadline, so
    // the abort runs before the answer is read.
    const result = check();
    setImmediate(() => blockEventLoop(5_200));

    expect(await result).toEqual({ status: "unavailable" });
    const log = failureLog();
    expect(log).toMatchObject({
      cause: "timeout",
      errorName: "TimeoutError",
      timeoutMs: 5000,
      newConnection: false,
    });
    expect(log).not.toHaveProperty("connectMs");
    expect(log.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(log.eventLoopBusyMs).toBeGreaterThanOrEqual(5_000);
  }, 15_000);
});
