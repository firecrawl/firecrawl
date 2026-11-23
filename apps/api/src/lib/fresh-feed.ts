export const FRESH_FEED_UPSTREAMS = ["local", "curated"] as const;
export type FreshFeedUpstream = (typeof FRESH_FEED_UPSTREAMS)[number];
export type FreshFeedUpstreamUrls = Partial<Record<FreshFeedUpstream, string>>;

export const FRESH_FEED_COLLECTION_HEADER = "X-Fresh-Feed-Collection";

const FRESH_FEED_UPSTREAM_SET: ReadonlySet<string> = new Set(
  FRESH_FEED_UPSTREAMS,
);

const COLLECTION_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface FreshFeedVerticalTarget {
  readonly upstream: FreshFeedUpstream;
  readonly subcategory: string;
}

const CURATED_VERTICAL_ALIASES: ReadonlyArray<
  readonly [slug: string, subcategory: string]
> = [
  ["newsroom-blogs", "newsroom_blogs"],
  ["newsroom_blogs", "newsroom_blogs"],
  ["tech-support", "tech_support"],
  ["tech_support", "tech_support"],
  ["gov-hqi", "gov_hqi"],
  ["gov_hqi", "gov_hqi"],
];

export const FRESH_FEED_VERTICALS: ReadonlyMap<
  string,
  FreshFeedVerticalTarget
> = new Map(
  CURATED_VERTICAL_ALIASES.map(([slug, subcategory]) => [
    slug,
    { upstream: "curated", subcategory },
  ]),
);

export function isFreshFeedUpstream(
  value: unknown,
): value is FreshFeedUpstream {
  return typeof value === "string" && FRESH_FEED_UPSTREAM_SET.has(value);
}

export function resolveFreshFeedVertical(
  vertical: string,
): FreshFeedVerticalTarget | undefined {
  return FRESH_FEED_VERTICALS.get(vertical);
}

export function isValidFreshFeedCollection(value: unknown): value is string {
  return typeof value === "string" && COLLECTION_SLUG_RE.test(value);
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

export function getFreshFeedUpstreams(env: {
  FRESH_FEED_URL?: string;
  FRESH_FEED_CURATED_URL?: string;
}): FreshFeedUpstreamUrls {
  return normalizeFreshFeedUpstreams({
    local: env.FRESH_FEED_URL,
    curated: env.FRESH_FEED_CURATED_URL,
  });
}

export function hasFreshFeedUpstreams(
  upstreams: FreshFeedUpstreamUrls,
): boolean {
  return FRESH_FEED_UPSTREAMS.some(key => Boolean(upstreams[key]));
}
