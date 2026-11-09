import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { Agent, fetch, interceptors, request, type Dispatcher } from "undici";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const config = vi.hoisted(() => ({
  ALLOW_LOCAL_WEBHOOKS: false as boolean | undefined,
  PROXY_SERVER: undefined as string | undefined,
  PROXY_USERNAME: undefined as string | undefined,
  PROXY_PASSWORD: undefined as string | undefined,
}));

vi.mock("../../../../config", () => ({ config }));

import {
  InsecureConnectionError,
  rejectPrivateIPLiteralTargets,
} from "./safeFetch";

const previousAllowLocalWebhooks = config.ALLOW_LOCAL_WEBHOOKS;

afterEach(() => {
  config.ALLOW_LOCAL_WEBHOOKS = previousAllowLocalWebhooks;
});

function invoke(origin: string) {
  const inner = vi.fn(() => true) as unknown as Dispatcher.Dispatch;
  const onError = vi.fn();
  const dispatch = rejectPrivateIPLiteralTargets(inner);

  const accepted = dispatch(
    {
      origin,
      path: "/",
      method: "GET",
    },
    { onError } as unknown as Dispatcher.DispatchHandler,
  );

  return { accepted, inner, onError };
}

async function listen(server: Server, host?: string) {
  server.listen(0, host);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test server");
  }

  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

function createTarget() {
  const target = { hits: 0, server: createServer() };
  target.server.on("request", (_req, res) => {
    target.hits += 1;
    res.end("private target reached");
  });
  return target;
}

function createConnectProxy() {
  const proxy = { connections: 0, server: createServer() };
  const tunnels = new Set<Socket>();
  proxy.server.on("connection", () => {
    proxy.connections += 1;
  });
  proxy.server.on("connect", (req, clientSocket: Socket, head) => {
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    tunnels.add(clientSocket).add(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const closeProxy = async () => {
    tunnels.forEach(socket => socket.destroy());
    await close(proxy.server);
  };
  return Object.assign(proxy, { close: closeProxy });
}

describe("proxy destination IP-literal guard", () => {
  it("rejects an IPv4 loopback target before dispatch", () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;

    const { accepted, inner, onError } = invoke("http://127.0.0.1:9911");

    expect(accepted).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(InsecureConnectionError);
  });

  it("rejects a bracketed IPv6 loopback target before dispatch", () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;

    const { inner, onError } = invoke("http://[::1]:9911");

    expect(inner).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(InsecureConnectionError);
  });

  it("passes a public IP literal to the underlying dispatcher", () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;

    const { inner, onError } = invoke("https://93.184.216.34/");

    expect(inner).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("preserves the explicit local-network opt-in", () => {
    config.ALLOW_LOCAL_WEBHOOKS = true;

    const { inner, onError } = invoke("http://127.0.0.1:9911");

    expect(inner).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    "http://2130706433",
    "http://0x7f.0.0.1",
    "http://0177.0.0.1",
    "http://127.1",
    "http://127.0.0.1.",
    "http://0",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://[::ffff:127.0.0.1]",
    "http://[fc00::1]",
    "http://localhost",
    "http://LOCALHOST.",
    "http://api.localhost",
  ])("rejects the private target %s before dispatch", origin => {
    config.ALLOW_LOCAL_WEBHOOKS = false;

    const { inner, onError } = invoke(origin);

    expect(inner).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(InsecureConnectionError);
  });

  it.each([
    "https://example.com",
    "http://localhost.example.com",
    "https://[2606:4700:4700::1111]",
  ])("passes the public target %s to the underlying dispatcher", origin => {
    config.ALLOW_LOCAL_WEBHOOKS = false;

    const { inner, onError } = invoke(origin);

    expect(inner).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-applies the guard when the redirect interceptor follows a Location", async () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;
    let redirectorHits = 0;

    const privateTarget = createTarget();
    const privateTargetPort = await listen(privateTarget.server, "127.0.0.1");

    const redirector = createServer((_req, res) => {
      redirectorHits += 1;
      res.writeHead(302, {
        location: `http://127.0.0.1:${privateTargetPort}/secret`,
      });
      res.end();
    });
    const redirectorPort = await listen(redirector, "127.0.0.1");

    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
      },
    }).compose(
      rejectPrivateIPLiteralTargets,
      interceptors.redirect({ maxRedirections: 5 }),
    );

    try {
      await expect(
        request(`http://redirector.test:${redirectorPort}/start`, {
          dispatcher,
        }),
      ).rejects.toBeInstanceOf(InsecureConnectionError);
      expect(redirectorHits).toBe(1);
      expect(privateTarget.hits).toBe(0);
    } finally {
      await dispatcher.close();
      await close(redirector);
      await close(privateTarget.server);
    }
  });
});

describe("getSecureDispatcher with PROXY_SERVER configured", () => {
  const target = createTarget();
  const proxy = createConnectProxy();
  let targetUrl: string;
  let safeFetch: typeof import("./safeFetch.js");

  beforeAll(async () => {
    targetUrl = `http://127.0.0.1:${await listen(target.server, "127.0.0.1")}/secret`;
    config.PROXY_SERVER = `http://127.0.0.1:${await listen(proxy.server, "127.0.0.1")}`;
    vi.resetModules();
    safeFetch = await import("./safeFetch.js");
  });

  afterAll(async () => {
    config.PROXY_SERVER = undefined;
    await proxy.close();
    await close(target.server);
  });

  it("never opens a proxy tunnel to a private IP literal", async () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;
    const proxyConnections = proxy.connections;
    const targetHits = target.hits;

    const error = await fetch(targetUrl, {
      dispatcher: safeFetch.getSecureDispatcher(),
    }).catch(e => e);

    expect(error).toBeInstanceOf(TypeError);
    expect(error.cause).toBeInstanceOf(safeFetch.InsecureConnectionError);
    expect(proxy.connections).toBe(proxyConnections);
    expect(target.hits).toBe(targetHits);
  });

  it("reaches a local target through the proxy when ALLOW_LOCAL_WEBHOOKS is set", async () => {
    config.ALLOW_LOCAL_WEBHOOKS = true;
    const proxyConnections = proxy.connections;

    const response = await fetch(targetUrl, {
      dispatcher: safeFetch.getSecureDispatcher(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private target reached");
    expect(proxy.connections).toBeGreaterThan(proxyConnections);
  });
});
