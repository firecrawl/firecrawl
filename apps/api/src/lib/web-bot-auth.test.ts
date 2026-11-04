import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { config } from "../config";
import { webBotAuthDirectory, webBotAuthHeaders } from "./web-bot-auth";

vi.mock("../config", () => ({ config: {} }));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
Object.assign(config, {
  WEB_BOT_AUTH_PRIVATE_KEY: privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString(),
  WEB_BOT_AUTH_SIGNATURE_AGENT: "https://api.firecrawl.dev",
  WEB_BOT_AUTH_TEAM_IDS: ["alexandria-team"],
});

function verifySignature(
  headers: Record<string, string>,
  componentLines: string[],
) {
  const params = headers["Signature-Input"].replace(/^sig1=/, "");
  const signature = headers.Signature.match(/^sig1=:(.+):$/)![1];
  const base = [...componentLines, `"@signature-params": ${params}`].join("\n");
  return verify(
    null,
    Buffer.from(base),
    publicKey,
    Buffer.from(signature, "base64"),
  );
}

describe("webBotAuthHeaders", () => {
  it("does not sign for teams outside the allowlist", () => {
    expect(webBotAuthHeaders("https://example.com/a", "other-team")).toEqual(
      {},
    );
    expect(webBotAuthHeaders("https://example.com/a", undefined)).toEqual({});
  });

  it("signs the request authority and signature agent", () => {
    const headers = webBotAuthHeaders(
      "https://News.Example.com:443/article?id=1",
      "alexandria-team",
    );

    expect(headers["Signature-Agent"]).toBe('"https://api.firecrawl.dev"');
    const params = headers["Signature-Input"];
    expect(params).toMatch(/^sig1=\("@authority" "signature-agent"\);/);
    expect(params).toContain(';alg="ed25519"');
    expect(params).toContain(';tag="web-bot-auth"');
    const created = Number(params.match(/;created=(\d+)/)![1]);
    const expires = Number(params.match(/;expires=(\d+)/)![1]);
    expect(expires - created).toBe(60);
    expect(Math.abs(created - Date.now() / 1000)).toBeLessThan(5);

    const jwk = publicKey.export({ format: "jwk" });
    const thumbprint = createHash("sha256")
      .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }))
      .digest("base64url");
    expect(params).toContain(`;keyid="${thumbprint}"`);

    expect(
      verifySignature(headers, [
        '"@authority": news.example.com',
        '"signature-agent": "https://api.firecrawl.dev"',
      ]),
    ).toBe(true);
    expect(
      verifySignature(headers, [
        '"@authority": other.example.com',
        '"signature-agent": "https://api.firecrawl.dev"',
      ]),
    ).toBe(false);
  });
});

describe("webBotAuthDirectory", () => {
  it("serves only the public key, signed for the requested authority", () => {
    const directory = webBotAuthDirectory("api.firecrawl.dev")!;

    expect(JSON.parse(directory.body)).toEqual({
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: publicKey.export({ format: "jwk" }).x,
        },
      ],
    });
    expect(directory.headers["Content-Type"]).toBe(
      "application/http-message-signatures-directory+json",
    );
    expect(directory.headers["Signature-Input"]).toMatch(
      /^sig1=\("@authority";req\);.*;tag="http-message-signatures-directory"$/,
    );
    expect(
      verifySignature(directory.headers, [
        '"@authority";req: api.firecrawl.dev',
      ]),
    ).toBe(true);
  });
});
