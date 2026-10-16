import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { config } from "../config";

export const WEB_BOT_AUTH_DIRECTORY_PATH =
  "/.well-known/http-message-signatures-directory";

// Cloudflare recommends short expiries against replay; signatures are minted
// right before each engine call.
const SIGNATURE_TTL_SECONDS = 60;

type SigningKey = {
  privateKey: KeyObject;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  keyId: string;
};

let cachedKey: SigningKey | null | undefined;

function signingKey(): SigningKey | null {
  if (cachedKey !== undefined) return cachedKey;
  if (!config.WEB_BOT_AUTH_PRIVATE_KEY || !config.WEB_BOT_AUTH_SIGNATURE_AGENT)
    return (cachedKey = null);

  const privateKey = createPrivateKey(config.WEB_BOT_AUTH_PRIVATE_KEY);
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  const jwk = { kty: "OKP", crv: "Ed25519", x: x! } as const;
  // RFC 7638 thumbprint: required members only, in lexicographic order.
  const keyId = createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");
  return (cachedKey = { privateKey, jwk, keyId });
}

/** Signs an RFC 9421 signature base built from `components` and returns the Signature-Input and Signature values. */
function signComponents(
  key: SigningKey,
  components: [name: string, value: string][],
  tag: string,
) {
  const created = Math.floor(Date.now() / 1000);
  const params =
    `(${components.map(([name]) => name).join(" ")})` +
    `;created=${created}` +
    `;expires=${created + SIGNATURE_TTL_SECONDS}` +
    `;keyid="${key.keyId}"` +
    `;alg="ed25519"` +
    `;nonce="${randomBytes(64).toString("base64")}"` +
    `;tag="${tag}"`;
  const base = [
    ...components.map(([name, value]) => `${name}: ${value}`),
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(base), key.privateKey);
  return {
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${signature.toString("base64")}:`,
  };
}

/**
 * Web Bot Auth headers for a request to `url`, or an empty object unless
 * signing is configured and `teamId` is allowlisted in WEB_BOT_AUTH_TEAM_IDS.
 */
export function webBotAuthHeaders(
  url: string,
  teamId: string | undefined,
): Record<string, string> {
  if (!teamId || !config.WEB_BOT_AUTH_TEAM_IDS?.includes(teamId)) return {};
  const key = signingKey();
  if (!key) return {};

  const signatureAgent = `"${config.WEB_BOT_AUTH_SIGNATURE_AGENT}"`;
  return {
    "Signature-Agent": signatureAgent,
    ...signComponents(
      key,
      [
        ['"@authority"', new URL(url).host],
        ['"signature-agent"', signatureAgent],
      ],
      "web-bot-auth",
    ),
  };
}

/** The signed key directory response for a request to `authority`, or null when signing is not configured. */
export function webBotAuthDirectory(authority: string) {
  const key = signingKey();
  if (!key) return null;
  return {
    body: JSON.stringify({ keys: [key.jwk] }),
    headers: {
      "Content-Type": "application/http-message-signatures-directory+json",
      "Cache-Control": "max-age=60",
      ...signComponents(
        key,
        [['"@authority";req', authority]],
        "http-message-signatures-directory",
      ),
    },
  };
}
