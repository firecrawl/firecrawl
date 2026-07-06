// URL canonicalization and lookup-expression generation for the Google Web
// Risk / Safe Browsing hash-prefix protocol.
// https://cloud.google.com/web-risk/docs/urls-hashing
//
// The threat lists store SHA-256 hash prefixes of *canonicalized expressions*
// (host[/path] strings). To check a target locally we must produce byte-exact
// expressions per the published spec — the canonicalization rules here are
// verified against Google's published test vectors (see canonicalize.test.ts).
//
// Everything in this file is pure string/byte manipulation: nothing is
// transmitted anywhere (ZDR — the check path only ever sends anonymized hash
// prefixes to Google, and only on a local prefix hit).

/**
 * Treats a JS string as a byte sequence: code units <= 0xFF are bytes,
 * anything above is UTF-8 encoded. Matches how reference implementations
 * operate on raw URL bytes.
 */
function toBytes(input: string): number[] {
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0)!;
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...Buffer.from(char, "utf8"));
    }
  }
  return bytes;
}

function fromBytes(bytes: number[]): string {
  return bytes.map(b => String.fromCharCode(b)).join("");
}

const HEX = "0123456789ABCDEF";

function isHexDigit(char: string): boolean {
  return /^[0-9a-fA-F]$/.test(char);
}

/** One pass of percent-unescaping (only valid %XX sequences). */
function unescapeOnce(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    if (
      input[i] === "%" &&
      i + 2 < input.length &&
      isHexDigit(input[i + 1]) &&
      isHexDigit(input[i + 2])
    ) {
      out += String.fromCharCode(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += input[i];
    }
  }
  return out;
}

/** Repeatedly percent-unescape until the string stops changing (spec step). */
function fullyUnescape(input: string): string {
  let prev = input;
  // Bounded to defend against adversarial inputs; real URLs converge fast.
  for (let i = 0; i < 1024; i++) {
    const next = unescapeOnce(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/**
 * Percent-escape bytes <= 0x20, >= 0x7F, '#' and '%', uppercase hex — the
 * spec's escape character class.
 */
function escapeBytes(input: string): string {
  const bytes = toBytes(input);
  let out = "";
  for (const byte of bytes) {
    if (
      byte <= 0x20 ||
      byte >= 0x7f ||
      byte === 0x23 /* # */ ||
      byte === 0x25 /* % */
    ) {
      out += "%" + HEX[byte >> 4] + HEX[byte & 0xf];
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/**
 * inet_aton-style IP parsing: 1-4 dot-separated components, each decimal,
 * octal (leading 0) or hex (0x); the last component fills the remaining
 * bytes. Returns the normalized dotted-quad, or null if not an IP.
 */
function canonicalizeIp(host: string): string | null {
  if (
    !/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i.test(host)
  ) {
    return null;
  }
  const parts = host.split(".");
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x/i.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]*$/.test(part)) {
      value = parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // All but the last component must fit in one byte; the last fills the rest.
  const tailBytes = 4 - (values.length - 1);
  const last = values[values.length - 1];
  if (last >= 2 ** (8 * tailBytes)) return null;
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 0xff) return null;
  }

  const bytes: number[] = values.slice(0, -1);
  for (let i = tailBytes - 1; i >= 0; i--) {
    bytes.push((last >> (8 * i)) & 0xff);
  }
  return bytes.join(".");
}

/**
 * Canonicalize a hostname per the spec: fully unescape, remove leading /
 * trailing dots, collapse consecutive dots, normalize IP forms to
 * dotted-quad, lowercase, then re-escape.
 */
export function canonicalizeHost(host: string): string {
  let out = fullyUnescape(host);
  out = out
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/\.{2,}/g, ".");
  out = out.toLowerCase();
  const ip = canonicalizeIp(out);
  if (ip !== null) out = ip;
  return escapeBytes(out);
}

/** Resolve "/./" and "/../" segments and collapse runs of slashes. */
function canonicalizePath(path: string): string {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === ".") {
      // Empty segments are runs of slashes (or the leading slash) — skip.
      continue;
    }
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const endsWithSlash =
    path.endsWith("/") ||
    path.endsWith("/.") ||
    path.endsWith("/..") ||
    out.length === 0;
  return "/" + out.join("/") + (endsWithSlash && out.length > 0 ? "/" : "");
}

interface ParsedUrl {
  scheme: string;
  host: string;
  path: string;
  query: string | null;
}

/**
 * Lenient URL splitter (real URL parsers reject hosts the spec requires us to
 * handle, e.g. embedded spaces or raw control bytes).
 */
function splitUrl(input: string): ParsedUrl {
  let rest = input;
  let scheme = "http";
  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }

  let hostEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "/" || rest[i] === "?") {
      hostEnd = i;
      break;
    }
  }
  let authority = rest.slice(0, hostEnd);
  const afterHost = rest.slice(hostEnd);

  // Strip userinfo and port from the authority.
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  const portMatch = authority.match(/^(.*):(\d*)$/);
  if (portMatch) authority = portMatch[1];

  let path = "/";
  let query: string | null = null;
  if (afterHost.length > 0) {
    const q = afterHost.indexOf("?");
    if (q !== -1) {
      path = q === 0 ? "/" : afterHost.slice(0, q);
      query = afterHost.slice(q + 1);
    } else {
      path = afterHost;
    }
  }

  return { scheme, host: authority, path, query };
}

/**
 * Full URL canonicalization per the Web Risk / Safe Browsing spec. Verified
 * against Google's published test vectors.
 */
export function canonicalizeUrl(input: string): string {
  // Leading/trailing whitespace, then embedded tab/CR/LF, then the fragment.
  let url = input.trim().replace(/[\t\r\n]/g, "");
  const hash = url.indexOf("#");
  if (hash !== -1) url = url.slice(0, hash);

  const { scheme, host, path, query } = splitUrl(url);

  const canonicalHost = canonicalizeHost(host);
  const canonicalPath = escapeBytes(canonicalizePath(fullyUnescape(path)));
  const canonicalQuery = query === null ? null : escapeBytes(query);

  return (
    `${scheme}://${canonicalHost}${canonicalPath}` +
    (canonicalQuery !== null ? `?${canonicalQuery}` : "")
  );
}

/** Whether a canonicalized host is a (dotted-quad) IP address. */
function isIpHost(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Host-suffix lookup expressions for a domain-level check, per the spec: the
 * exact hostname plus up to four suffixes formed from the last five host
 * components, successively dropping the leading component (never the bare
 * TLD), each with the "/" root path. IP hosts get a single expression.
 *
 * Firecrawl's threat protection is domain-level (we classify the target
 * domain, not individual URLs), so path variants are intentionally not
 * generated — this matches the previous uris:search behavior of looking up
 * `http://<domain>/`.
 */
export function generateHostExpressions(domain: string): string[] {
  const host = canonicalizeHost(domain.trim());
  if (host.length === 0) return [];
  if (isIpHost(host)) return [host + "/"];

  const expressions = [host + "/"];
  const parts = host.split(".");
  const maxSuffix = Math.min(5, parts.length - 1);
  for (let suffixLen = maxSuffix; suffixLen >= 2; suffixLen--) {
    const suffix = parts.slice(parts.length - suffixLen).join(".");
    if (suffix !== host) expressions.push(suffix + "/");
  }
  return expressions;
}
