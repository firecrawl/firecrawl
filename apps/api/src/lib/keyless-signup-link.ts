import { createCipheriv } from "node:crypto";
import { isIPv4 } from "node:net";
import { config } from "../config";
import { logger } from "./logger";

// Keyless prompts link to signup at https://firecrawl.dev/k/<token>. The token
// is the prompt itself, encrypted: nothing is stored per identity, and the web
// app decrypts it at signup to join the account to the keyless ledger.
//
// Token format. Keep identical to firecrawl-web lib/keyless-signup-link.ts.
//   Plaintext: a 60-bit integer, most significant bits first:
//     bits 59..28  keyless IPv4 address (a.b.c.d as a big-endian uint32)
//     bits 27..26  surface: 0 api, 1 mcp, 2 cli (3 reserved)
//     bits 25..23  prompt reason: 0 limit, 1 account_only_tool,
//                  2 unsupported_endpoint, 3 suspicious_ip (4..7 reserved)
//     bits 22..0   check: always zero
//   Written as 12 radix-32 numerals (5 bits each, most significant first) and
//   encrypted with NIST SP 800-38G FF1 over AES-128, radix 32, tweak the ASCII
//   bytes "fc-keyless-v1". The 12 output numerals are spelled in lowercase
//   Crockford base32 (0123456789abcdefghjkmnpqrstvwxyz).
//   A token is valid only if the 23 check bits decrypt to zero, so a forged or
//   mistyped token passes with odds of about 1 in 8.4 million per key.
//   Reserved surface or reason codes decode to null (a newer issuer).
//
// Keys: KEYLESS_SIGNUP_LINK_KEYS, comma-separated base64 16-byte AES keys. The
// first encrypts; decryption tries each in turn, so a rotated-out key keeps its
// links working while it stays in the list.
const KEYLESS_SIGNUP_LINK_BASE = "https://firecrawl.dev/k";

export type KeylessSignupSurface = "api" | "mcp" | "cli";

export type KeylessPromptReason =
  | "limit"
  | "account_only_tool"
  | "unsupported_endpoint"
  | "suspicious_ip";

// Index = code in the token. Append only.
const SURFACE_CODES: readonly KeylessSignupSurface[] = ["api", "mcp", "cli"];
const REASON_CODES: readonly KeylessPromptReason[] = [
  "limit",
  "account_only_tool",
  "unsupported_endpoint",
  "suspicious_ip",
];

const TOKEN_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TOKEN_LENGTH = 12;
const TOKEN_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
const TOKEN_TWEAK = Buffer.from("fc-keyless-v1", "ascii");
const CHECK_BITS = 23n;
const CHECK_MASK = (1n << CHECK_BITS) - 1n;

/**
 * The regular signup link, used whenever no token can be given (no key
 * configured, or no IPv4 identity). It still tags the signup keyless with its
 * surface through the UTMs the web app already reads, so only the per-identity
 * join is lost, not the attribution.
 */
export function keylessFallbackSignupUrl(
  surface: KeylessSignupSurface,
): string {
  return `https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=${surface}`;
}

// ---------------------------------------------------------------------------
// FF1 (NIST SP 800-38G) with AES-128. Numeral strings are arrays of digits in
// [0, radix), most significant first.

function aesBlock(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

// PRF of the spec: AES CBC-MAC with a zero IV over a whole number of blocks.
function prf(key: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return out.subarray(out.length - 16);
}

function numeralsToBigInt(numerals: number[], radix: number): bigint {
  const r = BigInt(radix);
  let x = 0n;
  for (const digit of numerals) x = x * r + BigInt(digit);
  return x;
}

function bigIntToNumerals(x: bigint, radix: number, length: number): number[] {
  const r = BigInt(radix);
  const out = new Array<number>(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x % r);
    x /= r;
  }
  return out;
}

function bigIntToBytes(x: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function ff1(
  key: Buffer,
  tweak: Buffer,
  radix: number,
  input: number[],
  encrypt: boolean,
): number[] {
  const n = input.length;
  if (key.length !== 16) throw new Error("FF1 needs a 16-byte AES-128 key");
  if (radix < 2 || radix > 65536 || n < 2) throw new Error("Bad FF1 domain");
  if (input.some(d => !Number.isInteger(d) || d < 0 || d >= radix)) {
    throw new Error("Numeral out of range");
  }
  const u = Math.floor(n / 2);
  const v = n - u;
  let A = input.slice(0, u);
  let B = input.slice(u);
  // b = ceil(ceil(v * log2(radix)) / 8), computed exactly.
  const b = Math.ceil((BigInt(radix) ** BigInt(v) - 1n).toString(2).length / 8);
  const d = 4 * Math.ceil(b / 4) + 4;
  const t = tweak.length;
  const P = Buffer.alloc(16);
  P.set([1, 2, 1], 0);
  P.writeUIntBE(radix, 3, 3);
  P[6] = 10;
  P[7] = u % 256;
  P.writeUInt32BE(n, 8);
  P.writeUInt32BE(t, 12);
  const pad = (((-t - b - 1) % 16) + 16) % 16;
  const extraBlocks = Math.ceil(d / 16) - 1;

  for (let round = 0; round < 10; round++) {
    const i = encrypt ? round : 9 - round;
    const Q = Buffer.concat([
      tweak,
      Buffer.alloc(pad),
      Buffer.from([i]),
      bigIntToBytes(numeralsToBigInt(encrypt ? B : A, radix), b),
    ]);
    const R = prf(key, Buffer.concat([P, Q]));
    const blocks = [R];
    for (let j = 1; j <= extraBlocks; j++) {
      const counter = bigIntToBytes(BigInt(j), 16);
      blocks.push(aesBlock(key, Buffer.from(R.map((x, k) => x ^ counter[k]))));
    }
    const y = BigInt(
      "0x" + Buffer.concat(blocks).subarray(0, d).toString("hex"),
    );
    const m = i % 2 === 0 ? u : v;
    const modulus = BigInt(radix) ** BigInt(m);
    if (encrypt) {
      const c = (numeralsToBigInt(A, radix) + y) % modulus;
      A = B;
      B = bigIntToNumerals(c, radix, m);
    } else {
      const c =
        (((numeralsToBigInt(B, radix) - y) % modulus) + modulus) % modulus;
      B = A;
      A = bigIntToNumerals(c, radix, m);
    }
  }
  return [...A, ...B];
}

export function ff1Encrypt(
  key: Buffer,
  tweak: Buffer,
  radix: number,
  numerals: number[],
): number[] {
  return ff1(key, tweak, radix, numerals, true);
}

export function ff1Decrypt(
  key: Buffer,
  tweak: Buffer,
  radix: number,
  numerals: number[],
): number[] {
  return ff1(key, tweak, radix, numerals, false);
}

// ---------------------------------------------------------------------------
// Token encode/decode.

type KeylessSignupPayload = {
  ipv4: string;
  surface: KeylessSignupSurface | null;
  reason: KeylessPromptReason | null;
};

// Canonical base64 of exactly 16 bytes.
const KEY_PATTERN = /^[A-Za-z0-9+/]{21}[AQgw]==$/;
let cachedKeys: { raw: string | undefined; keys: Buffer[] } | undefined;

/** Parsed KEYLESS_SIGNUP_LINK_KEYS; malformed entries are skipped. */
function signupLinkKeys(): Buffer[] {
  const raw = config.KEYLESS_SIGNUP_LINK_KEYS;
  if (cachedKeys && cachedKeys.raw === raw) return cachedKeys.keys;
  const keys = (raw ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => KEY_PATTERN.test(entry))
    .map(entry => Buffer.from(entry, "base64"));
  cachedKeys = { raw, keys };
  return keys;
}

/** The 12-character token for a prompt, or undefined for a non-IPv4 identity. */
export function encryptKeylessSignupToken(
  payload: {
    ipv4: string;
    surface: KeylessSignupSurface;
    reason: KeylessPromptReason;
  },
  key: Buffer,
): string | undefined {
  if (!isIPv4(payload.ipv4)) return undefined;
  const ip = payload.ipv4
    .split(".")
    .reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
  const plaintext =
    (ip << 28n) |
    (BigInt(SURFACE_CODES.indexOf(payload.surface)) << 26n) |
    (BigInt(REASON_CODES.indexOf(payload.reason)) << CHECK_BITS);
  return ff1Encrypt(
    key,
    TOKEN_TWEAK,
    32,
    bigIntToNumerals(plaintext, 32, TOKEN_LENGTH),
  )
    .map(d => TOKEN_ALPHABET[d])
    .join("");
}

/**
 * The prompt a token carries, or null when it is malformed or no key yields
 * zero check bits. Tries every configured key unless keys are given.
 */
export function decryptKeylessSignupToken(
  token: string,
  keys: Buffer[] = signupLinkKeys(),
): KeylessSignupPayload | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const numerals = [...token].map(c => TOKEN_ALPHABET.indexOf(c));
  for (const key of keys) {
    const plaintext = numeralsToBigInt(
      ff1Decrypt(key, TOKEN_TWEAK, 32, numerals),
      32,
    );
    if ((plaintext & CHECK_MASK) !== 0n) continue;
    const ip = Number(plaintext >> 28n);
    return {
      ipv4: [24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join("."),
      surface: SURFACE_CODES[Number((plaintext >> 26n) & 3n)] ?? null,
      reason: REASON_CODES[Number((plaintext >> CHECK_BITS) & 7n)] ?? null,
    };
  }
  return null;
}

/**
 * The caller's own signup link for a prompt: firecrawl.dev/k/<token> for an
 * IPv4 identity when a key is configured, else the regular signup link. Pure
 * CPU, no I/O, never throws. `signupRef` is the token, for logs.
 */
export function keylessSignupLink(
  ipv4: string | null | undefined,
  surface: KeylessSignupSurface,
  reason: KeylessPromptReason,
): { url: string; signupRef?: string } {
  try {
    const key = signupLinkKeys()[0];
    const token =
      ipv4 && key
        ? encryptKeylessSignupToken({ ipv4, surface, reason }, key)
        : undefined;
    if (token) {
      return { url: `${KEYLESS_SIGNUP_LINK_BASE}/${token}`, signupRef: token };
    }
  } catch (error) {
    logger.warn("Keyless signup link encryption failed", {
      module: "keyless-signup-link",
      surface,
      error,
    });
  }
  return { url: keylessFallbackSignupUrl(surface) };
}

// ---------------------------------------------------------------------------
// Surface classification.

type RequestLike = {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

function lowerString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function firstHeader(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

/**
 * Surface of a keyless prompt, from the same signals as the warehouse
 * `usage_source`: CLI when origin or integration is `cli`, MCP when origin
 * starts with `mcp` or the hosted MCP relayed the request with the proxy
 * secret. Everything else, including requests with no origin, is `api`: the
 * prompt reached the caller as a raw API response, which is what
 * utm_medium=api meant before.
 */
export function keylessSignupSurface(req: RequestLike): KeylessSignupSurface {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  // v1 schemas prefault a missing body origin to "api", which would mask an
  // x-origin header, so a bare "api" defers to the header. Classification is
  // case-insensitive, like the warehouse's.
  const bodyOrigin = lowerString(body.origin);
  const headerOrigin = lowerString(firstHeader(req, "x-origin"));
  const origin =
    bodyOrigin && bodyOrigin !== "api"
      ? bodyOrigin
      : (headerOrigin ?? bodyOrigin);
  const integration =
    lowerString(body.integration) ??
    lowerString(firstHeader(req, "x-integration"));
  if (
    config.KEYLESS_PROXY_SECRET &&
    firstHeader(req, "x-firecrawl-keyless-secret") ===
      config.KEYLESS_PROXY_SECRET
  ) {
    return "mcp";
  }
  if (integration === "cli" || origin === "cli") return "cli";
  if (origin?.startsWith("mcp")) return "mcp";
  return "api";
}
