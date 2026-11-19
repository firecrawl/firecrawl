/**
 * Query-string form of an Alexandria call for GET /v2/alexandria/:provider/*capability.
 *
 * Keys are matched against the capability's contract first: a key that is the exact name of a
 * declared option (`meta.version`, `timeout`) is that option, unsplit. Any other key uses dot notation to build nested options (`filters.country=US`), a repeated key builds a list
 * (`tags=a&tags=b`), and `\.` keeps a literal dot. `timeout` and `version` are request fields
 * unless the contract declares an option of that name; `options.` always reaches a provider
 * option. Query values carry no types, so top-level options are converted against the contract;
 * values nested inside an object option stay strings.
 */

export class AlexandriaQueryError extends Error {}

type Leaf = string | string[];
type Tree = { [key: string]: Tree | Leaf };

const MAX_DEPTH = 10;
const MAX_VALUES = 200;
const RESERVED = new Set(["timeout", "version"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Nothing that can carry a credential goes in a URL, where proxies, logs and browser history keep
// it: these names are refused at any level, however they are reached (directly, through
// `options.`, or declared by the contract), and so is any value shaped like a Firecrawl API key.
// The Firecrawl key belongs in the Authorization header, and such options go in a POST body.
// Zero-data-retention requests must not put their options in a URL either.
const REFUSED_QUERY_KEYS = new Set([
  "api_key",
  "apiKey",
  "apikey",
  "key",
  "token",
  "access_token",
  "accessToken",
  "secret",
  "password",
  "zeroDataRetention",
]);
const FIRECRAWL_KEY = /\bfc-[0-9a-f]{32}\b/i;

const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function splitKey(key: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < key.length; i++) {
    if (key[i] === "\\" && key[i + 1] === ".") {
      current += ".";
      i++;
    } else if (key[i] === ".") {
      segments.push(current);
      current = "";
    } else current += key[i];
  }
  segments.push(current);
  if (segments.some(segment => segment === ""))
    throw new AlexandriaQueryError(`Query key "${key}" has an empty segment.`);
  if (segments.some(segment => UNSAFE_KEYS.has(segment)))
    throw new AlexandriaQueryError(`Query key "${key}" is not allowed.`);
  if (segments.length > MAX_DEPTH)
    throw new AlexandriaQueryError(
      `Query key "${key}" nests deeper than ${MAX_DEPTH} levels.`,
    );
  return segments;
}

/**
 * Refuses a query that is too large or carries a credential. It needs no contract, so it runs
 * before the contract lookup and an unsafe URL costs nothing.
 */
export function checkAlexandriaQuery(query: Record<string, unknown>) {
  let values = 0;
  for (const [key, raw] of Object.entries(query)) {
    const list = (Array.isArray(raw) ? raw : [raw]).map(String);
    values += list.length;
    const names = key.replace(/\\\./g, ".").split(".");
    if (names.includes("zeroDataRetention"))
      throw new AlexandriaQueryError(
        "Zero data retention requests must use POST /v2/alexandria.",
      );
    if (names.some(name => REFUSED_QUERY_KEYS.has(name)))
      throw new AlexandriaQueryError(
        `"${key}" can carry a credential, so it cannot go in the URL. Send the API key in the Authorization header, and this option with POST /v2/alexandria.`,
      );
    if (list.some(value => FIRECRAWL_KEY.test(value)))
      throw new AlexandriaQueryError(
        "Send the API key in the Authorization header, not the URL.",
      );
  }
  if (values > MAX_VALUES)
    throw new AlexandriaQueryError(
      `A GET call takes at most ${MAX_VALUES} values. Use POST for larger calls.`,
    );
}

export function parseAlexandriaQuery(
  query: Record<string, unknown>,
  declared: ReadonlySet<string> = new Set(),
): {
  options: Tree;
  timeout?: string;
  version?: string;
} {
  checkAlexandriaQuery(query);
  const options: Tree = {};
  const request: { timeout?: string; version?: string } = {};
  for (const [key, raw] of Object.entries(query)) {
    const list = (Array.isArray(raw) ? raw : [raw]).map(String);
    const viaOptions =
      key.startsWith("options.") && key.length > 8 && !declared.has(key);
    const name = viaOptions ? key.slice(8) : key;
    let segments: string[];
    if (declared.has(name)) {
      if (UNSAFE_KEYS.has(name))
        throw new AlexandriaQueryError(`Query key "${key}" is not allowed.`);
      segments = [name];
    } else if (!viaOptions && RESERVED.has(name)) {
      if (list.length > 1)
        throw new AlexandriaQueryError(`"${name}" can only be given once.`);
      request[name as "timeout" | "version"] = list[0];
      continue;
    } else segments = splitKey(name);
    const value: Leaf = list.length === 1 ? list[0] : list;
    let node = options;
    for (const [i, segment] of segments.entries()) {
      const last = i === segments.length - 1;
      const existing = node[segment];
      if (last) {
        if (existing !== undefined)
          throw new AlexandriaQueryError(
            isTree(existing)
              ? `"${segments.join(".")}" is given as both a value and an object.`
              : `"${segments.join(".")}" is given twice.`,
          );
        node[segment] = value;
      } else {
        if (existing !== undefined && !isTree(existing))
          throw new AlexandriaQueryError(
            `"${segments.slice(0, i + 1).join(".")}" is given as both a value and an object.`,
          );
        node = (node[segment] ??= {}) as Tree;
      }
    }
  }
  return { options, ...request };
}

/** `{ "0": a, "1": b }` → `[a, b]`; anything else is returned unchanged. */
function indexedList(value: unknown): unknown {
  if (!isTree(value)) return value;
  const keys = Object.keys(value);
  if (!keys.length || !keys.every(key => /^(0|[1-9]\d*)$/.test(key)))
    return value;
  const indexes = keys.map(Number).sort((a, b) => a - b);
  if (indexes.some((index, i) => index !== i))
    throw new AlexandriaQueryError(
      "List indexes must run 0, 1, 2… with no gaps.",
    );
  return indexes.map(index => value[String(index)]);
}

const toNumber = (value: unknown) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  Number.isFinite(Number(value))
    ? Number(value)
    : value;

/**
 * Converts top-level options to the types their contract declares. Options
 * missing from the contract, and values that do not convert, pass through
 * unchanged so the Exchange's validation names the problem.
 */
export function convertAlexandriaOptions(
  options: Tree,
  types: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    const type = types.get(name);
    switch (type) {
      case "boolean":
        converted[name] =
          value === "true" ? true : value === "false" ? false : value;
        break;
      case "number":
        converted[name] = toNumber(value);
        break;
      case "number[]": {
        const list = indexedList(value);
        converted[name] = (Array.isArray(list) ? list : [list]).map(toNumber);
        break;
      }
      case "string[]":
      case "object[]": {
        // One value is a list of one, as the contract declares a list.
        const list = indexedList(value);
        converted[name] = Array.isArray(list) ? list : [list];
        break;
      }
      default:
        converted[name] = value;
    }
  }
  return converted;
}
