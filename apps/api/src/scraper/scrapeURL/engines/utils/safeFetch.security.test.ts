import { once } from "node:events";
import { createServer } from "node:http";
import { fetch } from "undici";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ ALLOW_LOCAL_WEBHOOKS: false }));
vi.mock("../../../../config", () => ({ config }));
vi.mock("node:dns", () => ({
  default: {
    lookup: (_host: string, _options: unknown, callback: Function) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]),
  },
}));

import {
  getSecureDispatcherNoCookies,
  InsecureConnectionError,
} from "./safeFetch";

let connections = 0;
const server = createServer((_req, res) => res.end("local webhook"));
server.on("connection", () => connections++);
let url: string;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server");
  url = `http://rebind.example:${address.port}/`;
});

afterEach(() => {
  config.ALLOW_LOCAL_WEBHOOKS = false;
});
afterAll(async () => {
  await getSecureDispatcherNoCookies().close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
});

it("rejects a DNS-resolved private host before establishing a TCP connection", async () => {
  const error = await fetch(url, {
    dispatcher: getSecureDispatcherNoCookies(),
  }).catch(e => e);
  expect(error.cause).toBeInstanceOf(InsecureConnectionError);
  expect(connections).toBe(0);
});

it("allows local delivery with the explicit deployment override", async () => {
  config.ALLOW_LOCAL_WEBHOOKS = true;
  const response = await fetch(url, {
    dispatcher: getSecureDispatcherNoCookies(),
  });
  expect(await response.text()).toBe("local webhook");
  expect(connections).toBe(1);
});
