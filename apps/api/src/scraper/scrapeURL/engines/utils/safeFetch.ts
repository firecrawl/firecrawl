import type { Socket } from "net";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { interceptors } from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import IPAddr from "ipaddr.js";

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

const normalizeProxyServer = (server: string) =>
  server.includes("://") ? server : "http://" + server;

const normalizeLocationCountry = (country?: string) => {
  if (!country) return undefined;
  const lowered = country.toLowerCase();
  if (lowered === "us-generic" || lowered === "us-whitelist") {
    return "US";
  }
  return country.toUpperCase();
};

export const buildProxyConfig = (location?: {
  country?: string;
}): ProxyConfig | null => {
  if (!config.PROXY_SERVER) return null;
  const country = normalizeLocationCountry(location?.country);
  const usernameBase = config.PROXY_USERNAME;
  const username =
    usernameBase && country ? `${usernameBase}-cc-${country}` : usernameBase;
  return {
    server: config.PROXY_SERVER,
    username,
    password: config.PROXY_PASSWORD,
  };
};

export const isLocationSupportedByProxy = (location?: {
  country?: string;
}) => {
  if (!location?.country) return true;
  return !!(config.PROXY_SERVER && config.PROXY_USERNAME);
};

const hasHeader = (headers: Record<string, string> | undefined, name: string) => {
  if (!headers) return false;
  const target = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === target);
};

export const mergeLocationHeaders = (
  headers: Record<string, string> | undefined,
  location?: { languages?: string[] },
) => {
  if (!location?.languages?.length) return headers;
  if (hasHeader(headers, "accept-language")) return headers;
  return {
    ...(headers ?? {}),
    "Accept-Language": location.languages.join(","),
  };
};

export function isIPPrivate(address: string): boolean {
  if (!IPAddr.isValid(address)) return false;

  const addr = IPAddr.parse(address);
  return addr.range() !== "unicast";
}

function createBaseAgent(
  skipTlsVerification: boolean,
  proxyConfig?: ProxyConfig | null,
) {
  const proxy = proxyConfig ?? (config.PROXY_SERVER ? {
    server: config.PROXY_SERVER,
    username: config.PROXY_USERNAME,
    password: config.PROXY_PASSWORD,
  } : null);

  const baseAgent = proxy
    ? new undici.ProxyAgent({
        uri: normalizeProxyServer(proxy.server),
        token: proxy.username
          ? `Basic ${Buffer.from(proxy.username + ":" + (proxy.password ?? "")).toString("base64")}`
          : undefined,
        requestTls: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      })
    : new undici.Agent({
        connect: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      });

  // Add redirect interceptor for handling redirects
  return baseAgent.compose(interceptors.redirect({ maxRedirections: 5000 }));
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

// Dispatcher WITH cookie handling (for scraping - needs cookies for auth flows)
function makeSecureDispatcher(
  skipTlsVerification: boolean,
  proxyConfig?: ProxyConfig | null,
) {
  const baseAgent = createBaseAgent(skipTlsVerification, proxyConfig);
  const cookieJar = new CookieJar();
  const agent = baseAgent.compose(cookie({ jar: cookieJar }));
  attachSecurityCheck(agent);
  return agent;
}

// Dispatcher WITHOUT cookie handling (for webhooks - avoids empty cookie header bug)
function makeSecureDispatcherNoCookies(
  skipTlsVerification: boolean,
  proxyConfig?: ProxyConfig | null,
) {
  const agent = createBaseAgent(skipTlsVerification, proxyConfig);
  attachSecurityCheck(agent);
  return agent;
}

const secureDispatcher = makeSecureDispatcher(false);
const secureDispatcherSkipTlsVerification = makeSecureDispatcher(true);
const secureDispatcherNoCookies = makeSecureDispatcherNoCookies(false);
const secureDispatcherNoCookiesSkipTlsVerification =
  makeSecureDispatcherNoCookies(true);

export const getSecureDispatcher = (
  skipTlsVerification: boolean = false,
  proxyConfig?: ProxyConfig | null,
) => {
  if (!proxyConfig) {
    return skipTlsVerification
      ? secureDispatcherSkipTlsVerification
      : secureDispatcher;
  }
  return makeSecureDispatcher(skipTlsVerification, proxyConfig);
};

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
  proxyConfig?: ProxyConfig | null,
) => {
  if (!proxyConfig) {
    return skipTlsVerification
      ? secureDispatcherNoCookiesSkipTlsVerification
      : secureDispatcherNoCookies;
  }
  return makeSecureDispatcherNoCookies(skipTlsVerification, proxyConfig);
};
