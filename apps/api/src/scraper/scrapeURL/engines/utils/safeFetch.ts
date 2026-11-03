import type { Socket } from "net";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { interceptors } from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import {
  assertSafeOutboundUrl,
  createSafeLookup,
  InsecureConnectionError,
  isIPPrivate,
} from "../../../../lib/outbound-url";
export {
  InsecureConnectionError,
  isIPPrivate,
} from "../../../../lib/outbound-url";

/**
 * Reject private IP literals and localhost names before dispatch, on the
 * initial request and every redirect hop. With PROXY_SERVER set, the socket
 * check below never sees the destination, so this is the only local guard.
 * Other hostnames are resolved proxy-side and must be filtered by the proxy.
 */
export const rejectPrivateIPLiteralTargets: undici.Dispatcher.DispatcherComposeInterceptor =
  dispatch => (options, handler) => {
    let privateTarget = false;

    try {
      if (options.origin === undefined) throw new InsecureConnectionError();
      assertSafeOutboundUrl(
        options.origin.toString(),
        config.ALLOW_LOCAL_WEBHOOKS === true,
      );
    } catch {
      privateTarget = true;
    }

    if (privateTarget) {
      const error = new InsecureConnectionError();
      const compatibleHandler = handler as typeof handler & {
        onResponseError?: (controller: unknown, error: Error) => void;
      };

      if (typeof compatibleHandler.onError === "function") {
        compatibleHandler.onError(error);
      } else if (typeof compatibleHandler.onResponseError === "function") {
        compatibleHandler.onResponseError(null, error);
      } else {
        throw error;
      }

      return true;
    }

    return dispatch(options, handler);
  };

function createBaseAgent(skipTlsVerification: boolean) {
  const baseAgent = config.PROXY_SERVER
    ? new undici.ProxyAgent({
        uri: config.PROXY_SERVER.includes("://")
          ? config.PROXY_SERVER
          : "http://" + config.PROXY_SERVER,
        token: config.PROXY_USERNAME
          ? `Basic ${Buffer.from(config.PROXY_USERNAME + ":" + (config.PROXY_PASSWORD ?? "")).toString("base64")}`
          : undefined,
        requestTls: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      })
    : new undici.Agent({
        connect: {
          lookup: createSafeLookup(() => config.ALLOW_LOCAL_WEBHOOKS === true),
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      });

  // Add redirect interceptor for handling redirects
  return baseAgent.compose(
    rejectPrivateIPLiteralTargets,
    interceptors.redirect({ maxRedirections: 5000 }),
  );
}

function attachSecurityCheck(agent: undici.Dispatcher) {
  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      x => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (
      socket.remoteAddress &&
      isIPPrivate(socket.remoteAddress) &&
      config.ALLOW_LOCAL_WEBHOOKS !== true
    ) {
      socket.destroy(new InsecureConnectionError());
    }
  });
}

function makeSecureDispatcher(skipTlsVerification: boolean) {
  const agent = createBaseAgent(skipTlsVerification);
  attachSecurityCheck(agent);
  return agent;
}

// Dispatcher WITHOUT cookie handling (for webhooks - avoids empty cookie header bug)
function makeSecureDispatcherNoCookies(skipTlsVerification: boolean) {
  const agent = createBaseAgent(skipTlsVerification);
  attachSecurityCheck(agent);
  return agent;
}

const secureDispatcher = makeSecureDispatcher(false);
const secureDispatcherSkipTlsVerification = makeSecureDispatcher(true);
const secureDispatcherNoCookies = makeSecureDispatcherNoCookies(false);
const secureDispatcherNoCookiesSkipTlsVerification =
  makeSecureDispatcherNoCookies(true);

export const getSecureDispatcher = (skipTlsVerification: boolean = false) => {
  const dispatcher = skipTlsVerification
    ? secureDispatcherSkipTlsVerification
    : secureDispatcher;

  return dispatcher.compose(cookie({ jar: new CookieJar() }));
};

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) =>
  skipTlsVerification
    ? secureDispatcherNoCookiesSkipTlsVerification
    : secureDispatcherNoCookies;
