export const FRESH_FEED_UPSTREAMS = ["local", "curated", "global"] as const;
export type FreshFeedUpstream = (typeof FRESH_FEED_UPSTREAMS)[number];
export type FreshFeedUpstreamUrls = Partial<Record<FreshFeedUpstream, string>>;

export const FRESH_FEED_COLLECTION_HEADER = "X-Fresh-Feed-Collection";

export const FRESH_FEED_FILTER_KEYS = [
  "subcategory",
  "country",
  "region",
  "domain",
  "host",
  "agents",
] as const;
export type FreshFeedFilterKey = (typeof FRESH_FEED_FILTER_KEYS)[number];
export type FreshFeedFilters = Partial<Record<FreshFeedFilterKey, string>>;

export const MAX_FRESH_FEED_AGENTS = 4;

const FRESH_FEED_UPSTREAM_SET: ReadonlySet<string> = new Set(
  FRESH_FEED_UPSTREAMS,
);
const FRESH_FEED_FILTER_KEY_SET: ReadonlySet<string> = new Set(
  FRESH_FEED_FILTER_KEYS,
);

const COLLECTION_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILTER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const AGENT_TOKEN_RE = /^[A-Za-z_-]{1,64}$/;
const RESERVED_AGENT_PREFIX = "not-ours-";
const MAX_FILTER_VALUE_LENGTH = 4096;

const FRESH_FEED_UPSTREAM_ENV_KEYS = {
  local: "FRESH_FEED_URL",
  curated: "FRESH_FEED_CURATED_URL",
  global: "FRESH_FEED_GLOBAL_URL",
} as const satisfies Record<FreshFeedUpstream, string>;

export type FreshFeedUpstreamEnv = Partial<
  Record<(typeof FRESH_FEED_UPSTREAM_ENV_KEYS)[FreshFeedUpstream], string>
>;

export interface FreshFeedUpstreamRouteDefinition {
  readonly path: string;
  readonly defaultUpstream?: FreshFeedUpstream;
  readonly allowedUpstreams: readonly FreshFeedUpstream[];
}

export const FRESH_FEED_UPSTREAM_ROUTES: ReadonlyArray<FreshFeedUpstreamRouteDefinition> =
  [
    {
      path: "/local/latest",
      defaultUpstream: "local",
      allowedUpstreams: FRESH_FEED_UPSTREAMS,
    },
    {
      path: "/curated/latest",
      allowedUpstreams: ["curated", "global"],
    },
    {
      path: "/global/latest",
      allowedUpstreams: ["global"],
    },
  ];

export interface FreshFeedVerticalTarget {
  readonly supportedUpstreams: readonly FreshFeedUpstream[];
  readonly subcategory: string;
}

const CURATED_AND_GLOBAL_UPSTREAMS: readonly FreshFeedUpstream[] = [
  "curated",
  "global",
];

const VERTICAL_ALIASES: ReadonlyArray<
  readonly [
    slug: string,
    subcategory: string,
    supportedUpstreams?: readonly FreshFeedUpstream[],
  ]
> = [
  ["newsroom-blogs", "newsroom_blogs"],
  ["newsroom_blogs", "newsroom_blogs"],
  ["tech-support", "tech_support"],
  ["tech_support", "tech_support"],
  ["gov-hqi", "gov_hqi"],
  ["gov_hqi", "gov_hqi"],
];

const FRESH_FEED_VERTICALS: ReadonlyMap<string, FreshFeedVerticalTarget> =
  new Map(
    VERTICAL_ALIASES.map(
      ([
        slug,
        subcategory,
        supportedUpstreams = CURATED_AND_GLOBAL_UPSTREAMS,
      ]) => [slug, { supportedUpstreams, subcategory }],
    ),
  );

export function isFreshFeedUpstream(
  value: unknown,
): value is FreshFeedUpstream {
  return typeof value === "string" && FRESH_FEED_UPSTREAM_SET.has(value);
}

function isFreshFeedFilterKey(value: unknown): value is FreshFeedFilterKey {
  return typeof value === "string" && FRESH_FEED_FILTER_KEY_SET.has(value);
}

export function resolveFreshFeedVertical(
  vertical: string,
): FreshFeedVerticalTarget | undefined {
  return FRESH_FEED_VERTICALS.get(vertical);
}

export function isValidFreshFeedCollection(value: unknown): value is string {
  return typeof value === "string" && COLLECTION_SLUG_RE.test(value);
}

function isValidFreshFeedFilterToken(value: string): boolean {
  return FILTER_TOKEN_RE.test(value);
}

export function isValidFreshFeedAgentToken(value: string): boolean {
  return (
    AGENT_TOKEN_RE.test(value) &&
    !value.toLowerCase().startsWith(RESERVED_AGENT_PREFIX)
  );
}

export function normalizeFreshFeedHostToken(value: string): string {
  let normalized = value
    .replace(/^ +| +$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  const colon = normalized.lastIndexOf(":");
  if (colon > 0) {
    const port = normalized.slice(colon + 1);
    if (/^\d+$/.test(port)) {
      normalized = normalized.slice(0, colon).replace(/\.+$/, "");
    }
  }
  return normalized;
}

export function parseFreshFeedFilters(
  value: unknown,
): { filters: FreshFeedFilters } | { error: string } {
  if (value === undefined || value === null) {
    return { filters: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "freshFeedFilters must be a plain object" };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return { error: "freshFeedFilters must be a plain object" };
  }
  const filters: FreshFeedFilters = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isFreshFeedFilterKey(key)) {
      return { error: `Unknown freshFeedFilters key: ${key}` };
    }
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > MAX_FILTER_VALUE_LENGTH
    ) {
      return { error: `Invalid freshFeedFilters value for ${key}` };
    }
    const tokens = raw.split(",");
    if (key === "agents") {
      if (tokens.length > MAX_FRESH_FEED_AGENTS) {
        return { error: `Too many freshFeedFilters tokens for ${key}` };
      }
      const seen = new Set<string>();
      for (const token of tokens) {
        if (!isValidFreshFeedAgentToken(token)) {
          return { error: `Invalid freshFeedFilters token for ${key}` };
        }
        const folded = token.toLowerCase();
        if (seen.has(folded)) {
          return { error: `Duplicate freshFeedFilters token for ${key}` };
        }
        seen.add(folded);
      }
    } else if (tokens.some(token => !isValidFreshFeedFilterToken(token))) {
      return { error: `Invalid freshFeedFilters token for ${key}` };
    }
    filters[key] = raw;
  }
  return { filters };
}

export function freshFeedUpstreamPath(upstream: FreshFeedUpstream): string {
  return `/fresh-vertical-feed/${upstream}/latest`;
}

export function normalizeFreshFeedUpstreams(
  upstream: string | FreshFeedUpstreamUrls,
): FreshFeedUpstreamUrls {
  const input: FreshFeedUpstreamUrls =
    typeof upstream === "string" ? { local: upstream } : upstream;
  const normalized: FreshFeedUpstreamUrls = {};
  for (const key of FRESH_FEED_UPSTREAMS) {
    const raw = input[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (trimmed.length > 0) {
      normalized[key] = trimmed;
    }
  }
  return normalized;
}

export function getFreshFeedUpstreams(
  env: FreshFeedUpstreamEnv,
): FreshFeedUpstreamUrls {
  const urls: FreshFeedUpstreamUrls = {};
  for (const upstream of FRESH_FEED_UPSTREAMS) {
    urls[upstream] = env[FRESH_FEED_UPSTREAM_ENV_KEYS[upstream]];
  }
  return normalizeFreshFeedUpstreams(urls);
}

export function hasFreshFeedUpstreams(
  upstreams: FreshFeedUpstreamUrls,
): boolean {
  return FRESH_FEED_UPSTREAMS.some(key => Boolean(upstreams[key]));
}
