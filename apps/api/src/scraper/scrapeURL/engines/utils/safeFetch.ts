import type { Socket } from "net";
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

function makeSecureDispatcher(skipTlsVerification: boolean) {
  const agentOpts: undici.Agent.Options = {
    maxRedirections: 5000,
  };

  const baseAgent = process.env.PROXY_SERVER
    ? new undici.ProxyAgent({
        uri: process.env.PROXY_SERVER.includes("://")
          ? process.env.PROXY_SERVER
          : "http://" + process.env.PROXY_SERVER,
        token: process.env.PROXY_USERNAME
          ? `Basic ${Buffer.from(process.env.PROXY_USERNAME + ":" + (process.env.PROXY_PASSWORD ?? "")).toString("base64")}`
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

  const cookieJar = new CookieJar();

  const agent = baseAgent.compose(cookie({ jar: cookieJar }));

  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      x => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (
      socket.remoteAddress &&
      isIPPrivate(socket.remoteAddress) &&
      process.env.ALLOW_LOCAL_WEBHOOKS !== "true"
    ) {
      socket.destroy(new InsecureConnectionError());
    }
  });

  return agent;
}

const secureDispatcher = makeSecureDispatcher(false);
const secureDispatcherSkipTlsVerification = makeSecureDispatcher(true);

export const getSecureDispatcher = (skipTlsVerification: boolean = false) =>
  skipTlsVerification ? secureDispatcherSkipTlsVerification : secureDispatcher;
