import dns from "node:dns";
import IPAddr from "ipaddr.js";
import { ErrorCodes, TransportableError } from "./error";

export class InsecureConnectionError extends TransportableError {
  constructor() {
    super("SCRAPE_UNSAFE_DESTINATION", "Connection violated security rules.");
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const error = new InsecureConnectionError();
    error.stack = data.stack;
    return error;
  }
}

export function isIPPrivate(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "");
  return IPAddr.isValid(host) && IPAddr.parse(host).range() !== "unicast";
}

/** Validate URL syntax and literal destinations before queueing or dispatching.
 * DNS names must additionally be checked by the transport that opens the socket.
 */
export function assertSafeOutboundUrl(
  value: string | URL,
  allowPrivate = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InsecureConnectionError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InsecureConnectionError();
  }
  if (
    !allowPrivate &&
    (isIPPrivate(url.hostname) || /(^|\.)localhost\.?$/i.test(url.hostname))
  ) {
    throw new InsecureConnectionError();
  }
  return url;
}

export function isSafeOutboundUrl(
  value: string,
  allowPrivate = false,
): boolean {
  try {
    assertSafeOutboundUrl(value, allowPrivate);
    return true;
  } catch {
    return false;
  }
}

/** Defense in depth before handing a URL to another service. The receiving
 * service still has to validate its own DNS results and every redirect hop.
 */
export async function assertSafeOutboundDestination(
  value: string,
  allowPrivate = false,
  resolve = (hostname: string) => dns.promises.lookup(hostname, { all: true }),
): Promise<void> {
  const url = assertSafeOutboundUrl(value, allowPrivate);
  if (allowPrivate) return;
  await resolvePublicOutboundAddresses(url, resolve);
}

/** Return the same validated addresses the transport must connect to. */
export async function resolvePublicOutboundAddresses(
  value: string | URL,
  resolve = (hostname: string) => dns.promises.lookup(hostname, { all: true }),
): Promise<dns.LookupAddress[]> {
  const url = assertSafeOutboundUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (IPAddr.isValid(hostname)) {
    return [
      {
        address: hostname,
        family: IPAddr.parse(hostname).kind() === "ipv6" ? 6 : 4,
      },
    ];
  }
  const addresses = await resolve(hostname);
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !IPAddr.isValid(address) || isIPPrivate(address),
    )
  ) {
    throw new InsecureConnectionError();
  }
  return addresses;
}

/** Validate the actual lookup result passed to Node's socket connector. Checking
 * all answers prevents dual-stack fallback from reaching a private address;
 * returning these same answers avoids a second, unvalidated DNS resolution.
 */
export function createSafeLookup(
  allowPrivate: () => boolean,
  resolve: typeof dns.lookup = dns.lookup,
): typeof dns.lookup {
  return ((
    hostname: string,
    options: dns.LookupOptions | number,
    callback: (
      error: NodeJS.ErrnoException | null,
      address?: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const opts = typeof options === "number" ? { family: options } : options;
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (
        !addresses.length ||
        (!allowPrivate() &&
          addresses.some(
            ({ address }) => !IPAddr.isValid(address) || isIPPrivate(address),
          ))
      ) {
        return callback(new InsecureConnectionError());
      }
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  }) as typeof dns.lookup;
}
