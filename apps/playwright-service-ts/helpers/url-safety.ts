import dotenv from 'dotenv';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';

dotenv.config();

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

export const isInternalHost = async (hostname: string): Promise<boolean> => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  let addresses: string[];
  if (IPAddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return true;
    }
  }
  return (
    addresses.length === 0 ||
    addresses.some((a) => IPAddr.parse(a).range() !== 'unicast')
  );
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
