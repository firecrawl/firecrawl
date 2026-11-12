// The X/Twitter URLs the Exchange's X provider answers: posts and profiles.
// Scrape sends these to the Exchange for eligible teams and requests (see
// lib/exchange.ts and buildFallbackList in scraper/scrapeURL/engines).

const RESERVED_PROFILE_PATHS = new Set([
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "login",
  "logout",
  "messages",
  "notifications",
  "search",
  "settings",
  "share",
]);

type XTwitterProfileUrl = {
  kind: "profile";
  handle: string;
  normalizedUrl: string;
};

type XTwitterPostUrl = {
  kind: "post";
  handle?: string;
  postId: string;
  normalizedUrl: string;
};

type XTwitterUrl = XTwitterProfileUrl | XTwitterPostUrl;

function parseXTwitterUrl(url: string): XTwitterUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (
    hostname !== "x.com" &&
    hostname !== "twitter.com" &&
    hostname !== "mobile.twitter.com"
  ) {
    return null;
  }

  const segments = parsed.pathname
    .split("/")
    .map(segment => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  if (
    segments.length >= 4 &&
    segments[0] === "i" &&
    segments[1] === "web" &&
    segments[2] === "status" &&
    isPostId(segments[3])
  ) {
    return {
      kind: "post",
      postId: segments[3],
      normalizedUrl: `https://x.com/i/web/status/${segments[3]}`,
    };
  }

  if (
    segments.length >= 3 &&
    segments[0] === "i" &&
    segments[1] === "status" &&
    isPostId(segments[2])
  ) {
    return {
      kind: "post",
      postId: segments[2],
      normalizedUrl: `https://x.com/i/web/status/${segments[2]}`,
    };
  }

  if (
    segments.length >= 3 &&
    isHandle(segments[0]) &&
    ["status", "statuses"].includes(segments[1]) &&
    isPostId(segments[2])
  ) {
    const handle = segments[0];
    const postId = segments[2];
    return {
      kind: "post",
      handle,
      postId,
      normalizedUrl: `https://x.com/${handle}/status/${postId}`,
    };
  }

  if (
    segments.length === 1 &&
    isHandle(segments[0]) &&
    !RESERVED_PROFILE_PATHS.has(segments[0].toLowerCase())
  ) {
    const handle = segments[0];
    return {
      kind: "profile",
      handle,
      normalizedUrl: `https://x.com/${handle}`,
    };
  }

  return null;
}

export function isXTwitterUrl(url: string): boolean {
  return parseXTwitterUrl(url) !== null;
}

function isHandle(value: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(value);
}

function isPostId(value: string): boolean {
  return /^\d{5,}$/.test(value);
}
