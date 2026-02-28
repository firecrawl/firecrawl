import express from "express";
import type { Server } from "http";

/**
 * End-to-end test that verifies the scrape endpoint honours a caller-supplied
 * user-agent header instead of silently replacing it with a random one.
 *
 * The test starts two HTTP servers:
 *   1. A tiny "echo" server that records the User-Agent it receives.
 *   2. The playwright-service itself (imported from ../api.ts).
 *
 * We then POST to /scrape with headers.user-agent set and assert the echo
 * server saw the exact value we asked for.
 */

let echoServer: Server;
let echoPort: number;
let receivedUserAgent: string | undefined;

// We need the playwright service running — import triggers listen().
// Override PORT so it picks a free one.
const PW_PORT = 13377;
process.env.PORT = String(PW_PORT);

beforeAll(async () => {
  // 1. Start echo server
  const echoApp = express();
  await new Promise<void>((resolve) => {
    echoServer = echoApp.get("/ua-echo", (req, res) => {
      receivedUserAgent = req.headers["user-agent"];
      res.send("ok");
    }).listen(0, () => {
      echoPort = (echoServer.address() as any).port;
      resolve();
    });
  });

  // 2. Start playwright service (gives it time to launch browser)
  await import("../api");
  // Wait for browser init
  await new Promise((r) => setTimeout(r, 3000));
}, 30_000);

afterAll(async () => {
  echoServer?.close();
});

it("uses custom user-agent from headers when provided", async () => {
  const customUA = "MyCustomAgent/1.0 (firecrawl-test)";
  receivedUserAgent = undefined;

  const res = await fetch(`http://localhost:${PW_PORT}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `http://localhost:${echoPort}/ua-echo`,
      headers: { "user-agent": customUA },
      timeout: 10000,
    }),
  });

  expect(res.status).toBe(200);
  expect(receivedUserAgent).toBe(customUA);
}, 20_000);

it("falls back to random user-agent when none supplied", async () => {
  receivedUserAgent = undefined;

  const res = await fetch(`http://localhost:${PW_PORT}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `http://localhost:${echoPort}/ua-echo`,
      timeout: 10000,
    }),
  });

  expect(res.status).toBe(200);
  // Should be a real browser-like UA, not empty or undefined
  expect(receivedUserAgent).toBeDefined();
  expect(receivedUserAgent!.length).toBeGreaterThan(10);
  // Should NOT be our custom one
  expect(receivedUserAgent).not.toBe("MyCustomAgent/1.0 (firecrawl-test)");
}, 20_000);
