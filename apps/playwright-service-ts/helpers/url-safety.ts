import dotenv from 'dotenv';
import type * as dns from 'node:dns';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';

dotenv.config();

const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');

export const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';
export const ALLOW_PRIVATE_IP_SCRAPING =
  (process.env.ALLOW_PRIVATE_IP_SCRAPING || 'False').toUpperCase() === 'TRUE';

export class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export const resolvePublicHostAddresses = async (
  hostname: string,
): Promise<ResolvedAddress[] | null> => {
  // URL.hostname returns IPv6 literals bracketed ("[::1]"); ipaddr.js and
  // dns.lookup both reject bracketed forms, so unwrap before validating.
  const host = normalizeHostname(hostname);
  if (!host) return null;

  let addressStrings: string[];
  if (IPAddr.isValid(host)) {
    addressStrings = [host];
  } else {
    try {
      addressStrings = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return null;
    }
  }
  if (addressStrings.length === 0) return null;

  const addresses: ResolvedAddress[] = [];
  for (const address of addressStrings) {
    try {
      const parsed = IPAddr.parse(address);
      if (parsed.range() !== 'unicast') return null;
      addresses.push({
        address,
        family: parsed.kind() === 'ipv6' ? 6 : 4,
      });
    } catch {
      return null;
    }
  }
  return addresses;
};

export const isInternalHost = async (hostname: string): Promise<boolean> => {
  return (await resolvePublicHostAddresses(hostname)) === null;
};

export const createSafeDnsLookup = (
  addresses: ResolvedAddress[],
): typeof dns['lookup'] => {
  const lookup = (
    hostname: string,
    options: any,
    callback: any,
  ): void => {
    let opts: any = options;
    if (typeof options === 'function') {
      callback = options;
      opts = {};
    }

    const family = opts?.family ?? 0;
    const all = opts?.all ?? false;
    const candidates = family
      ? addresses.filter((a) => a.family === family)
      : addresses;
    const fallback = candidates.length > 0 ? candidates : addresses;

    if (all) {
      callback(null, fallback);
    } else {
      const first = fallback[0];
      callback(null, first.address, first.family);
    }
  };
  return lookup as typeof dns['lookup'];
};

export const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }
  if (
    !ALLOW_LOCAL_WEBHOOKS &&
    !ALLOW_PRIVATE_IP_SCRAPING &&
    (await isInternalHost(parsedUrl.hostname))
  ) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};
