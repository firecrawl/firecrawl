import UserAgent from 'user-agents';

const DESKTOP_PLATFORM_TOKENS: Record<string, string> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
};

export const buildDesktopChromeUserAgent = (
  browserVersion: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const normalizedVersion = browserVersion
    ?.trim()
    .replace(/^(?:Headless)?Chrome\//i, '');
  if (!normalizedVersion || !/^\d+(?:\.\d+)*$/.test(normalizedVersion)) {
    return undefined;
  }
  const osToken = DESKTOP_PLATFORM_TOKENS[platform] ?? 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${normalizedVersion} Safari/537.36`;
};

export const resolveContextUserAgent = (
  userAgentOverride?: string,
  defaultDesktopUserAgent?: string,
): string => {
  const trimmedOverride = userAgentOverride?.trim();
  if (trimmedOverride) {
    return userAgentOverride!;
  }
  if (defaultDesktopUserAgent) {
    return defaultDesktopUserAgent;
  }
  return new UserAgent({ deviceCategory: 'desktop' }).toString();
};
