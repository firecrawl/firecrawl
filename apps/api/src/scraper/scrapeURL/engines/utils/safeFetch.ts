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
  resolvePublicOutboundAddresses,
} from "../../../../lib/outbound-url";
export {
  InsecureConnectionError,
  isIPPrivate,
} from "../../../../lib/outbound-url";

// Node's certificate verification errors, which rejectUnauthorized: false
// suppresses. CRL and OpenSSL hostname codes are omitted: Node never checks those.
export const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_CHAIN_TOO_LONG",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "UNSPECIFIED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Reject private IP literals and localhost names before dispatch, on the
 * initial request and every redirect hop. DNS is checked by the direct socket
 * lookup or pinned to an IP literal in the proxy CONNECT request below.
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

// ProxyAgent's clientFactory is used only for its HTTP(S) CONNECT transport.
// Resolve the destination here, immediately before opening each tunnel, and
// send an IP literal so the proxy cannot resolve the hostname a second time.
const pinProxyTargets: undici.Dispatcher.DispatcherComposeInterceptor =
  dispatch => (options, handler) => {
    if (config.ALLOW_LOCAL_WEBHOOKS === true) return dispatch(options, handler);

    void (async () => {
      if (options.method !== "CONNECT") throw new InsecureConnectionError();
      const destination = new URL(`http://${options.path}`);
      const [address] = await resolvePublicOutboundAddresses(destination);
      const host =
        address.family === 6 ? `[${address.address}]` : address.address;
      const authority = `${host}:${destination.port || "80"}`;
      dispatch(
        {
          ...options,
          path: authority,
          // ProxyAgent supplies a header record here (including proxy auth).
          // The tunneled request's Host and TLS SNI remain the original host.
          headers: { ...options.headers, host: authority },
        },
        handler,
      );
    })().catch(error => {
      const compatibleHandler = handler as typeof handler & {
        onResponseError?: (controller: unknown, error: Error) => void;
      };
      if (typeof compatibleHandler.onError === "function") {
        compatibleHandler.onError(error);
      } else {
        compatibleHandler.onResponseError!(null, error);
      }
    });
    return true;
  };

function createBaseAgent(skipTlsVerification: boolean) {
  if (config.PROXY_SERVER && config.ALLOW_LOCAL_WEBHOOKS !== true) {
    const protocol = new URL(
      config.PROXY_SERVER.includes("://")
        ? config.PROXY_SERVER
        : `http://${config.PROXY_SERVER}`,
    ).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(
        "Secure outbound requests require an HTTP(S) CONNECT proxy",
      );
    }
  }
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
        clientFactory: (origin, options) =>
          new undici.Pool(origin, options).compose(pinProxyTargets),
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
  // The proxy is operator-configured infrastructure and may itself be local.
  // Its remoteAddress is not the target; pinProxyTargets checks that instead.
  if (config.PROXY_SERVER) return;
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
