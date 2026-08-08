import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Agent, interceptors, request, type Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  server.close();
  await once(server, "close");
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

  it("re-applies the guard when the redirect interceptor follows a Location", async () => {
    config.ALLOW_LOCAL_WEBHOOKS = false;
    let privateTargetHits = 0;

    const privateTarget = createServer((_req, res) => {
      privateTargetHits += 1;
      res.end("private target reached");
    });
    const privateTargetPort = await listen(privateTarget, "127.0.0.1");

    const redirector = createServer((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${privateTargetPort}/secret`,
      });
      res.end();
    });
    const redirectorPort = await listen(redirector);

    const dispatcher = new Agent().compose(
      rejectPrivateIPLiteralTargets,
      interceptors.redirect({ maxRedirections: 5 }),
    );

    try {
      await expect(
        request(`http://localhost:${redirectorPort}/start`, { dispatcher }),
      ).rejects.toBeInstanceOf(InsecureConnectionError);
      expect(privateTargetHits).toBe(0);
    } finally {
      await dispatcher.close();
      await close(redirector);
      await close(privateTarget);
    }
  });
});
