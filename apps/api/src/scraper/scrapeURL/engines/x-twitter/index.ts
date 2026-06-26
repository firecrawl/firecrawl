import { xai } from "@ai-sdk/xai";
import { generateText, jsonSchema, Output } from "ai";
import { config } from "../../../../config";
import { EngineError, XTwitterConfigurationError } from "../../error";
import { safeMarkdownToHtml } from "../../parsers/pdf/markdownToHtml";
import { Meta } from "../../lib/meta";
import { Engine, EngineScrapeResult, SpecialEngine } from "../types";

const XAI_RESPONSES_MODEL = "grok-4-1-fast-non-reasoning";

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

type ProfilePost = {
  text: string;
  url?: string | null;
  createdAt?: string | null;
  likes?: number | null;
  retweets?: number | null;
};

type XTwitterProfileData = {
  displayName?: string | null;
  username?: string | null;
  profilePicUrl?: string | null;
  bio?: string | null;
  followers?: number | null;
  accountVerified?: boolean | null;
  url?: string | null;
  latestPosts?: ProfilePost[] | null;
};

type ThreadPost = {
  authorDisplayName?: string | null;
  authorUsername?: string | null;
  text: string;
  url?: string | null;
  createdAt?: string | null;
  likes?: number | null;
  retweets?: number | null;
};

type PostComment = {
  authorDisplayName?: string | null;
  authorUsername?: string | null;
  text: string;
  url?: string | null;
  createdAt?: string | null;
  likes?: number | null;
};

type XTwitterPostData = {
  authorDisplayName?: string | null;
  authorUsername?: string | null;
  text: string;
  url?: string | null;
  createdAt?: string | null;
  likes?: number | null;
  retweets?: number | null;
  thread?: ThreadPost[] | null;
  comments?: PostComment[] | null;
};

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const nullableBoolean = { type: ["boolean", "null"] };

const profileSchema = {
  type: "object",
  properties: {
    displayName: nullableString,
    username: nullableString,
    profilePicUrl: nullableString,
    bio: nullableString,
    followers: nullableNumber,
    accountVerified: nullableBoolean,
    url: nullableString,
    latestPosts: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          url: nullableString,
          createdAt: nullableString,
          likes: nullableNumber,
          retweets: nullableNumber,
        },
        required: ["text", "url", "createdAt", "likes", "retweets"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "displayName",
    "username",
    "profilePicUrl",
    "bio",
    "followers",
    "accountVerified",
    "url",
    "latestPosts",
  ],
  additionalProperties: false,
};

const postSchema = {
  type: "object",
  properties: {
    authorDisplayName: nullableString,
    authorUsername: nullableString,
    text: { type: "string" },
    url: nullableString,
    createdAt: nullableString,
    likes: nullableNumber,
    retweets: nullableNumber,
    thread: {
      type: "array",
      items: {
        type: "object",
        properties: {
          authorDisplayName: nullableString,
          authorUsername: nullableString,
          text: { type: "string" },
          url: nullableString,
          createdAt: nullableString,
          likes: nullableNumber,
          retweets: nullableNumber,
        },
        required: [
          "authorDisplayName",
          "authorUsername",
          "text",
          "url",
          "createdAt",
          "likes",
          "retweets",
        ],
        additionalProperties: false,
      },
    },
    comments: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          authorDisplayName: nullableString,
          authorUsername: nullableString,
          text: { type: "string" },
          url: nullableString,
          createdAt: nullableString,
          likes: nullableNumber,
        },
        required: [
          "authorDisplayName",
          "authorUsername",
          "text",
          "url",
          "createdAt",
          "likes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "authorDisplayName",
    "authorUsername",
    "text",
    "url",
    "createdAt",
    "likes",
    "retweets",
    "thread",
    "comments",
  ],
  additionalProperties: false,
};

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

function isXTwitterUrl(url: string): boolean {
  return parseXTwitterUrl(url) !== null;
}

async function scrapeURLWithXTwitter(meta: Meta): Promise<EngineScrapeResult> {
  const urlToScrape = meta.rewrittenUrl ?? meta.url;
  const xUrl = parseXTwitterUrl(urlToScrape);

  if (!xUrl) {
    throw new EngineError(
      `URL is not a supported X/Twitter URL: ${urlToScrape}`,
    );
  }

  if (!config.XAI_API_KEY) {
    throw new XTwitterConfigurationError();
  }

  meta.logger.info("Fetching X/Twitter data through Grok", {
    kind: xUrl.kind,
    url: xUrl.normalizedUrl,
  });

  const markdown =
    xUrl.kind === "profile"
      ? buildProfileMarkdown(await fetchProfile(xUrl, meta))
      : buildPostMarkdown(await fetchPost(xUrl, meta));

  if (markdown.trim().length === 0) {
    throw new EngineError(`No X/Twitter content returned for: ${urlToScrape}`);
  }

  const html = await safeMarkdownToHtml(markdown, meta.logger, meta.id);

  return {
    url: xUrl.normalizedUrl,
    html,
    markdown,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    proxyUsed: "basic",
    postprocessorsUsed: ["x-twitter"],
  };
}

function buildProfileMarkdown(profile: XTwitterProfileData): string {
  const username = stripAt(profile.username) ?? "unknown";
  const displayName = profile.displayName?.trim() || `@${username}`;
  const posts = (profile.latestPosts ?? []).slice(0, 5);
  const lines = [
    `# ${escapeMarkdownInline(displayName)} (@${escapeMarkdownInline(username)})`,
    "",
  ];

  if (profile.bio) {
    lines.push(escapeMarkdownBlock(profile.bio), "");
  }

  const facts = [
    `Followers: ${
      profile.followers !== null && profile.followers !== undefined
        ? formatNumber(profile.followers)
        : "Unknown"
    }`,
    `Verified: ${
      profile.accountVerified !== null && profile.accountVerified !== undefined
        ? profile.accountVerified
          ? "yes"
          : "no"
        : "Unknown"
    }`,
    `Profile Picture: ${
      profile.profilePicUrl
        ? formatMarkdownImage(displayName, profile.profilePicUrl)
        : "Unknown"
    }`,
    profile.url
      ? `Source: ${formatMarkdownLink(profile.url, profile.url)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  if (facts.length > 0) {
    lines.push(...facts.map(fact => `- ${fact}`), "");
  }

  lines.push("## Latest Posts", "");

  if (posts.length === 0) {
    lines.push("No recent top-level posts were returned.");
  } else {
    for (const [index, post] of posts.entries()) {
      lines.push(`### ${index + 1}. Post`);
      if (post.createdAt) {
        lines.push(`Posted: ${escapeMarkdownInline(post.createdAt)}`);
      }
      if (post.url) {
        lines.push(`URL: ${formatMarkdownLink(post.url, post.url)}`);
      }
      lines.push("");
      lines.push(formatBlockquote(post.text));
      const metrics = formatMetrics(post);
      if (metrics.length > 0) {
        lines.push("", metrics.join(" | "));
      }
      lines.push("");
    }
  }

  return trimMarkdown(lines.join("\n"));
}

function buildPostMarkdown(post: XTwitterPostData): string {
  const username = stripAt(post.authorUsername);
  const title = username
    ? `Post by @${escapeMarkdownInline(username)}`
    : "X/Twitter Post";
  const lines = [`# ${title}`, ""];

  const byline = [
    post.authorDisplayName?.trim()
      ? escapeMarkdownInline(post.authorDisplayName)
      : undefined,
    username ? `@${escapeMarkdownInline(username)}` : undefined,
  ].filter(Boolean);

  if (byline.length > 0) {
    lines.push(`Author: ${byline.join(" ")}`);
  }
  if (post.createdAt) {
    lines.push(`Posted: ${escapeMarkdownInline(post.createdAt)}`);
  }
  if (post.url) {
    lines.push(`URL: ${formatMarkdownLink(post.url, post.url)}`);
  }

  const metrics = formatMetrics(post);
  if (metrics.length > 0) {
    lines.push(metrics.join(" | "));
  }

  lines.push("", "## Post", "", escapeMarkdownBlock(post.text.trim()));

  const thread = (post.thread ?? []).filter(item => item.text?.trim());
  if (thread.length > 0) {
    lines.push("", "## Thread", "");
    for (const [index, threadPost] of thread.entries()) {
      lines.push(`### ${index + 1}. Thread Post`);
      if (threadPost.authorUsername) {
        lines.push(
          `Author: @${escapeMarkdownInline(stripAt(threadPost.authorUsername)!)}`,
        );
      }
      if (threadPost.createdAt) {
        lines.push(`Posted: ${escapeMarkdownInline(threadPost.createdAt)}`);
      }
      if (threadPost.url) {
        lines.push(
          `URL: ${formatMarkdownLink(threadPost.url, threadPost.url)}`,
        );
      }
      lines.push("", formatBlockquote(threadPost.text));
      const threadMetrics = formatMetrics(threadPost);
      if (threadMetrics.length > 0) {
        lines.push("", threadMetrics.join(" | "));
      }
      lines.push("");
    }
  }

  const comments = (post.comments ?? [])
    .filter(comment => comment.text?.trim())
    .slice(0, 5);
  lines.push("", "## Top Comments", "");
  if (comments.length === 0) {
    lines.push("No top comments were returned.");
  } else {
    for (const [index, comment] of comments.entries()) {
      const author = stripAt(comment.authorUsername);
      lines.push(
        `### ${index + 1}. ${
          author ? `@${escapeMarkdownInline(author)}` : "Comment"
        }`,
      );
      if (comment.authorDisplayName) {
        lines.push(
          `Author: ${escapeMarkdownInline(comment.authorDisplayName)}`,
        );
      }
      if (comment.createdAt) {
        lines.push(`Posted: ${escapeMarkdownInline(comment.createdAt)}`);
      }
      if (comment.url) {
        lines.push(`URL: ${formatMarkdownLink(comment.url, comment.url)}`);
      }
      lines.push("", formatBlockquote(comment.text));
      if (comment.likes !== null && comment.likes !== undefined) {
        lines.push("", `Likes: ${formatNumber(comment.likes)}`);
      }
      lines.push("");
    }
  }

  return trimMarkdown(lines.join("\n"));
}

async function fetchProfile(
  xUrl: XTwitterProfileUrl,
  meta: Meta,
): Promise<XTwitterProfileData> {
  const { output } = await generateText({
    model: xai.responses(XAI_RESPONSES_MODEL),
    maxOutputTokens: 20000,
    tools: {
      x_search: xai.tools.xSearch(),
    } as any,
    toolChoice: { type: "tool", toolName: "x_search" },
    output: Output.object({
      schema: jsonSchema(profileSchema as any),
      name: "x_twitter_profile",
      description:
        "Current public X/Twitter profile data and latest top-level posts.",
    }),
    abortSignal: meta.abort.asSignal(),
    prompt: `Give me current public X/Twitter profile details for @${xUrl.handle}: display name, username, profile picture URL, bio, follower count, verification status, and profile URL. Also return exactly the 5 latest posts authored by @${xUrl.handle} that are top-level posts, not replies or comments. Include fewer posts only if fewer public non-reply posts are available. Use the current public X data available to x_search.`,
  });

  return output as XTwitterProfileData;
}

async function fetchPost(
  xUrl: XTwitterPostUrl,
  meta: Meta,
): Promise<XTwitterPostData> {
  const handlePart = xUrl.handle ? ` by @${xUrl.handle}` : "";
  const toolsOptions = xUrl.handle
    ? {
        allowedXHandles: [xUrl.handle],
        enableVideoUnderstanding: true,
        enableImageUnderstanding: true,
      }
    : {
        enableVideoUnderstanding: true,
        enableImageUnderstanding: true,
      };

  const { output } = await generateText({
    model: xai.responses(XAI_RESPONSES_MODEL),
    maxOutputTokens: 20000,
    tools: {
      x_search: xai.tools.xSearch(toolsOptions),
    } as any,
    toolChoice: { type: "tool", toolName: "x_search" },
    output: Output.object({
      schema: jsonSchema(postSchema as any),
      name: "x_twitter_post",
      description:
        "Current public X/Twitter post data with metrics, thread, and top comments.",
    }),
    abortSignal: meta.abort.asSignal(),
    prompt: `Fetch the public X/Twitter post${handlePart} with post id ${xUrl.postId} at ${xUrl.normalizedUrl}. Return the post body in text as GitHub-flavored Markdown, preserving its original structure like headings and lists. Also return author, URL, created date, likes, and retweets. If this post is part of a thread, return the unrolled thread in chronological order under thread. Return the top 5 public comments or replies to the post under comments. Use the current public X data available to x_search.`,
  });

  return output as XTwitterPostData;
}

function isHandle(value: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(value);
}

function isPostId(value: string): boolean {
  return /^\d{5,}$/.test(value);
}

function stripAt(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^@/, "");
}

function formatMetrics(item: {
  likes?: number | null;
  retweets?: number | null;
}): string[] {
  return [
    item.likes !== null && item.likes !== undefined
      ? `Likes: ${formatNumber(item.likes)}`
      : undefined,
    item.retweets !== null && item.retweets !== undefined
      ? `Retweets: ${formatNumber(item.retweets)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBlockquote(value: string): string {
  const escaped = escapeMarkdownBlock(value.trim());
  if (!escaped) {
    return "> ";
  }
  return escaped
    .split(/\r?\n/)
    .map(line => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function formatMarkdownLink(label: string, url: string): string {
  const sanitizedUrl = sanitizeMarkdownUrl(url);
  if (!sanitizedUrl) {
    return escapeMarkdownInline(label);
  }
  return `[${escapeMarkdownInline(label)}](${sanitizedUrl})`;
}

function formatMarkdownImage(alt: string, url: string): string {
  const sanitizedUrl = sanitizeMarkdownUrl(url);
  if (!sanitizedUrl) {
    return "Unknown";
  }
  return `![${escapeMarkdownInline(alt)}](${sanitizedUrl})`;
}

function sanitizeMarkdownUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return undefined;
    }
    return parsed.toString().replace(/\)/g, "%29");
  } catch {
    return undefined;
  }
}

function escapeMarkdownInline(value: string): string {
  return escapeMarkdownBlock(value).replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}

function escapeMarkdownBlock(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function trimMarkdown(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export const xTwitterSpecialEngine: SpecialEngine = {
  name: "x-twitter",
  features: {
    actions: false,
    waitFor: false,
    screenshot: false,
    "screenshot@fullScreen": false,
    audio: false,
    video: false,
    atsv: false,
    location: false,
    mobile: false,
    branding: false,
    disableAdblock: true,
  },
  scrape: meta => {
    const logger = meta.logger.child({
      function: "scrapeURLWithXTwitter",
      engine: "x-twitter",
    });

    return scrapeURLWithXTwitter({
      ...meta,
      logger,
    });
  },
  special: {
    matches: isXTwitterUrl,
  },
};
