import dns, { LookupAddress } from 'dns';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';
import { PrepareRequestFunction, RequestError } from 'proxy-chain';

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true });

/**
 * Resolves `hostname` once. Returns the addresses if all of them are public
 * unicast, or null if the host is empty, does not resolve, or has any
 * non-unicast address (private, loopback, link-local, IPv4-mapped IPv6, ...).
 */
export const resolvePublicAddresses = async (
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<LookupAddress[] | null> => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  let addresses: LookupAddress[];
  if (IPAddr.isValid(host)) {
    const ip = IPAddr.parse(host);
    addresses = [
      { address: ip.toString(), family: ip.kind() === 'ipv6' ? 6 : 4 },
    ];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      return null;
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some((a) => IPAddr.parse(a.address).range() !== 'unicast')
  ) {
    return null;
  }
  return addresses;
};

export const isInternalHost = async (hostname: string): Promise<boolean> =>
  (await resolvePublicAddresses(hostname)) === null;

/**
 * A `dns.lookup` replacement that answers only with addresses that were
 * already checked, so the socket connects to the address the guard approved
 * and Node never resolves the host a second time.
 */
export const pinnedLookup = (addresses: LookupAddress[]): typeof dns.lookup =>
  ((
    _hostname: string,
    opts: dns.LookupOptions,
    cb: (
      err: NodeJS.ErrnoException | null,
      address?: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const family = opts.family;
    const matches =
      family === 4 || family === 6
        ? addresses.filter((a) => a.family === family)
        : addresses;

    process.nextTick(() => {
      if (matches.length === 0) {
        const err: NodeJS.ErrnoException = new Error(
          `No pinned address for family ${family}`,
        );
        err.code = 'ENOTFOUND';
        cb(err);
      } else if (opts.all) {
        cb(null, matches);
      } else {
        cb(null, matches[0].address, matches[0].family);
      }
    });
  }) as typeof dns.lookup;

export const ssrfPrepareRequest =
  ({
    allowLocal,
    upstreamProxyUrl,
    resolve,
  }: {
    allowLocal: boolean;
    upstreamProxyUrl?: string;
    resolve?: Resolver;
  }): PrepareRequestFunction =>
  async ({ hostname }) => {
    if (allowLocal) return { upstreamProxyUrl };

    const addresses = await resolvePublicAddresses(hostname, resolve);
    if (!addresses) {
      throw new RequestError(
        'Blocked: target resolves to a private/internal address',
        403,
      );
    }
    // With an upstream proxy, proxy-chain uses dnsLookup for the proxy host,
    // and the upstream proxy resolves the target itself. That proxy must
    // enforce its own egress policy; this check is only a pre-check there.
    if (upstreamProxyUrl) return { upstreamProxyUrl };
    return { dnsLookup: pinnedLookup(addresses) };
  };
