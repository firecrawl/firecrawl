import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { fetch } from "undici";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { ALLOW_LOCAL_WEBHOOKS: false, PROXY_SERVER: "" },
  lookup: vi.fn(),
}));
vi.mock("../../../../config", () => ({ config: mocks.config }));
vi.mock("node:dns", async importOriginal => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: { ...actual.promises, lookup: mocks.lookup },
    },
  };
});

let safeFetch: typeof import("./safeFetch");
let port: number;
const authorities: string[] = [];
const hosts: string[] = [];
const sockets = new Set<Socket>();
const targetPorts = new Set<number>();
const target = createServer((req, res) => {
  hosts.push(req.headers.host!);
  if (req.url === "/redirect") {
    res.writeHead(302, {
      location: `http://redirect-private.example:${port}/secret`,
    });
    res.end();
    return;
  }
  res.end("public page");
});
// Simulate a proxy serving the validated public IP without using the internet.
const proxy = createServer();
proxy.on("connect", (req, client: Socket, head) => {
  authorities.push(req.url!);
  const targetPort = Number(new URL(`http://${req.url}`).port);
  if (!targetPorts.has(targetPort)) {
    client.destroy();
    return;
  }
  const upstream = connect(targetPort, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  sockets.add(client).add(upstream);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

beforeAll(async () => {
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  port = (target.address() as import("node:net").AddressInfo).port;
  targetPorts.add(port);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  mocks.config.PROXY_SERVER = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  safeFetch = await import("./safeFetch.js");
});

afterAll(async () => {
  await safeFetch.getSecureDispatcherNoCookies().close();
  sockets.forEach(socket => socket.destroy());
  await Promise.all(
    [target, proxy].map(
      server => new Promise<void>(resolve => server.close(() => resolve())),
    ),
  );
});

it("pins CONNECT to the validated IP while preserving the destination Host header", async () => {
  mocks.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
  const response = await fetch(`http://public.example:${port}/`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  });
  expect(await response.text()).toBe("public page");
  expect(authorities).toEqual([`93.184.216.34:${port}`]);
  expect(hosts).toEqual([`public.example:${port}`]);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});

it("rejects a new tunnel when DNS has changed to a private address", async () => {
  mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  const previous = authorities.length;
  const error = await fetch(`http://rebound.example:${port}/`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  }).catch(error => error);
  expect(error.cause).toBeInstanceOf(safeFetch.InsecureConnectionError);
  expect(authorities).toHaveLength(previous);
});

it("pins public IPv6 destinations using bracketed CONNECT authorities", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const response = await fetch(`http://ipv6-public.example:${port}/`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  });
  expect(await response.text()).toBe("public page");
  expect(authorities.at(-1)).toBe(`[2606:4700:4700::1111]:${port}`);
  expect(hosts.at(-1)).toBe(`ipv6-public.example:${port}`);
});

it("fails closed when proxy destination DNS cannot be resolved", async () => {
  const failure = new Error("DNS resolution failed");
  mocks.lookup.mockRejectedValue(failure);
  const previous = authorities.length;
  const error = await fetch(`http://missing.example:${port}/`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  }).catch(error => error);
  expect(error.cause).toBe(failure);
  expect(authorities).toHaveLength(previous);
});

it("rejects mixed public/private DNS answers without opening a tunnel", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "::1", family: 6 },
  ]);
  const previous = authorities.length;
  const error = await fetch(`http://mixed.example:${port}/`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  }).catch(error => error);
  expect(error.cause).toBeInstanceOf(safeFetch.InsecureConnectionError);
  expect(authorities).toHaveLength(previous);
});

it("checks a redirect's DNS before opening its proxy tunnel", async () => {
  mocks.lookup
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
  const previous = authorities.length;
  const error = await fetch(`http://redirect-public.example:${port}/redirect`, {
    dispatcher: safeFetch.getSecureDispatcherNoCookies(),
  }).catch(error => error);
  expect(error.cause).toBeInstanceOf(safeFetch.InsecureConnectionError);
  expect(authorities).toHaveLength(previous + 1);
  expect(hosts).not.toContain(`redirect-private.example:${port}`);
});

it("preserves the original TLS server name through an IP-pinned tunnel", async () => {
  const names: string[] = [];
  const tlsTarget = createTlsServer({
    SNICallback: (name, callback) => {
      names.push(name);
      // Stop after ClientHello: no certificate or external TLS endpoint needed.
      callback(new Error("Test stopped after observing SNI"));
    },
  });
  tlsTarget.on("tlsClientError", () => {});
  tlsTarget.listen(0, "127.0.0.1");
  await once(tlsTarget, "listening");
  const tlsPort = (tlsTarget.address() as import("node:net").AddressInfo).port;
  targetPorts.add(tlsPort);
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  try {
    await expect(
      fetch(`https://tls-public.example:${tlsPort}/`, {
        dispatcher: safeFetch.getSecureDispatcherNoCookies(),
      }),
    ).rejects.toThrow();
    expect(names).toEqual(["tls-public.example"]);
    expect(authorities.at(-1)).toBe(`93.184.216.34:${tlsPort}`);
  } finally {
    await new Promise<void>(resolve => tlsTarget.close(() => resolve()));
  }
});
