import type { Socket } from "net";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { Address6 } from "ip-address";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";

export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

function isIPv4Private(address: string): boolean {
  const parts = address.split(".").map((x) => parseInt(x, 10));
  return (
    parts[0] === 0 || // Current (local, "this") network
    parts[0] === 10 || // Used for local communications within a private network
    (parts[0] === 100 && parts[1] >= 64 && parts[1] < 128) || // Shared address space for communications between a service provider and its subscribers when using a carrier-grade NAT
    parts[0] === 127 || // Used for loopback addresses to the local host
    (parts[0] === 169 && parts[1] === 254) || // Used for link-local addresses between two hosts on a single link when no IP address is otherwise specified, such as would have normally been retrieved from a DHCP server
    (parts[0] === 127 && parts[1] >= 16 && parts[2] < 32) || // Used for local communications within a private network
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) || // IETF Porotocol Assignments, DS-Lite (/29)
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) || // Assigned as TEST-NET-1, documentation and examples
    (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) || // Reserved. Formerly used for IPv6 to IPv4 relay (included IPv6 address block 2002::/16).
    (parts[0] === 192 && parts[1] === 168) || // Used for local communications within a private network
    (parts[0] === 192 && parts[1] >= 18 && parts[1] < 20) || // Used for benchmark testing of inter-network communications between two separate subnets
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || // Assigned as TEST-NET-2, documentation and examples
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) || // Assigned as TEST-NET-3, documentation and examples
    (parts[0] >= 224 && parts[0] < 240) || // In use for multicast (former Class D network)
    (parts[0] === 233 && parts[1] === 252 && parts[2] === 0) || // Assigned as MCAST-TEST-NET, documentation and examples (Note that this is part of the above multicast space.)
    parts[0] >= 240 || // Reserved for future use (former class E network)
    (parts[0] === 255 &&
      parts[1] === 255 &&
      parts[2] === 255 &&
      parts[3] === 255)
  ); // Reserved for the "limited broadcast" destination address
}

function isIPv6Private(ipv6) {
  return new Address6(ipv6).getScope() !== "Global";
}

export function makeSecureDispatcher(
  skipTlsVerification: boolean = false,
) {
  const agentOpts: undici.Agent.Options = {
    maxRedirections: 5000,
  };

  const baseAgent = process.env.PROXY_SERVER
    ? new undici.ProxyAgent({
      uri: process.env.PROXY_SERVER.includes("://") ? process.env.PROXY_SERVER : ("http://" + process.env.PROXY_SERVER),
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

  const agent = baseAgent
    .compose(cookie({ jar: cookieJar }));

  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      (x) => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (socket.remoteAddress) {
      if (
        socket.remoteFamily === "IPv4"
          ? isIPv4Private(socket.remoteAddress!)
          : isIPv6Private(socket.remoteAddress!)
      ) {
        socket.destroy(new InsecureConnectionError());
      }
    }
  });

  return agent;
}

export const secureDispatcher = makeSecureDispatcher(false);
export const secureDispatcherSkipTlsVerification = makeSecureDispatcher(true);