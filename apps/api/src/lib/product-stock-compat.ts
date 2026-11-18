// First release of each SDK whose product model accepts `inStock: null`.
// Older releases parse it as an error or as false, so they keep receiving true.
const NULL_STOCK_SINCE: Record<string, readonly [number, number, number]> = {
  python: [4, 58, 0],
  js: [4, 55, 0],
  java: [1, 19, 0],
  go: [1, 17, 0],
  rust: [2, 22, 0],
  ruby: [1, 18, 0],
  php: [1, 17, 0],
  dotnet: [1, 16, 0],
};

function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * Whether a request's client can read `inStock: null`. Origins are
 * `<lang>-sdk@<version>` or `<lang>-sdk.<package>@<version>`; anything that is
 * not one of the SDKs above (raw HTTP, integrations, MCP, CLI) gets null.
 */
export function acceptsNullStock(origin: string | null | undefined): boolean {
  const normalized = (origin ?? "").split("|")[0].trim().toLowerCase();
  const sdk = /^([a-z]+)-sdk(?:\.[^@]*)?(?:@(.*))?$/.exec(normalized);
  if (!sdk) return true;
  const since = NULL_STOCK_SINCE[sdk[1]];
  if (!since) return true;
  // A known SDK with a missing, prerelease or malformed version is treated as old.
  const version = parseVersion(sdk[2] ?? "");
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== since[i]) return version[i] > since[i];
  }
  return true;
}

/** Replaces unknown stock with the pre-null default (true) for clients that can't read null. */
export function withLegacyStockDefaults<T extends { variants?: unknown }>(
  product: T,
): T {
  if (!Array.isArray(product.variants)) return product;
  return {
    ...product,
    variants: product.variants.map(variant => {
      if (variant === null || typeof variant !== "object") return variant;
      const availability = (variant as { availability?: unknown }).availability;
      const current =
        availability !== null && typeof availability === "object"
          ? (availability as Record<string, unknown>)
          : {};
      if (typeof current.inStock === "boolean") return variant;
      return { ...variant, availability: { ...current, inStock: true } };
    }),
  };
}
