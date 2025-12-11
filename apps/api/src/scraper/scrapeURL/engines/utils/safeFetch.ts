import type { Socket } from "net";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import IPAddr from "ipaddr.js";
export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

export function isIPPrivate(address: string): boolean {
  if (!IPAddr.isValid(address)) return false;

  const addr = IPAddr.parse(address);
  return addr.range() !== "unicast";
}

function createBaseAgent(skipTlsVerification: boolean) {
  const agentOpts: undici.Agent.Options = {
    maxRedirections: 5000,
  };

  return config.PROXY_SERVER
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
        ...agentOpts,
      })
    : new undici.Agent({
        connect: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
        ...agentOpts,
      });
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
function makeSecureDispatcher(skipTlsVerification: boolean) {
  const baseAgent = createBaseAgent(skipTlsVerification);
  const cookieJar = new CookieJar();
  const agent = baseAgent.compose(cookie({ jar: cookieJar }));
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

export const getSecureDispatcher = (skipTlsVerification: boolean = false) =>
  skipTlsVerification ? secureDispatcherSkipTlsVerification : secureDispatcher;

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) =>
  skipTlsVerification
    ? secureDispatcherNoCookiesSkipTlsVerification
    : secureDispatcherNoCookies;
