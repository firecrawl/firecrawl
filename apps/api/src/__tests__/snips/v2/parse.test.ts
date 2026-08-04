import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import crypto from "node:crypto";
import request, {
  idmux,
  Identity,
  parse,
  parseWithFailure,
  scrapeTimeout,
  TEST_API_URL,
} from "./lib";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { config } from "../../../config";
import { getRedisConnection } from "../../../services/queue-service";

const DOCX_FIXTURE_BASE64 =
  "UEsDBBQAAAAIAKtlbVzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgAq2VtXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgAq2VtXCCNfXOwAAAA7AAAABEAAAB3b3JkL2RvY3VtZW50LnhtbDWOMQvCMBCFd3/FkV1THURKGwfFVQcF19icWmjuQi5a/fcmBZeP93jw3TXbjx/gjVF6plYtF5UCpI5dT49WXc6H+UaBJEvODkzYqi+K2ppZM9aOu5dHSpANJPXYqmdKodZauid6KwsOSHm7c/Q25RofeuToQuQORfIBP+hVVa21tz0pMwPI1hu7b4lTCSYjFiRzslEQ9sfdFS5hYOvgjJIaXbbCODFMGv33lPT/0/wAUEsBAhQDFAAAAAgAq2VtXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACACrZW1cIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACACrZW1cII19c7AAAADsAAAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAA3AIAAAAA";

const htmlFixture = `
<!DOCTYPE html>
<html>
  <body>
    <h1>Parse HTML Upload Test</h1>
    <p>This is a multipart parse upload test.</p>
  </body>
</html>
`;

let identity: Identity;
let pdfFixture: Buffer | null = null;
const originalParseUploadStorageDriver = config.PARSE_UPLOAD_STORAGE_DRIVER;
const originalEnv = config.ENV;
const parseUploadRefTestRequired =
  process.env.PARSE_UPLOAD_REF_TEST_REQUIRED === "true";
const parseUploadUnparsedWindowMs = 24 * 60 * 60 * 1000;
const keylessRequestsPerDay = Number(process.env.KEYLESS_REQUESTS_PER_DAY);
const keylessCreditsPerDay = Number(process.env.KEYLESS_CREDITS_PER_DAY);
const keylessEnabled =
  Number.isFinite(keylessRequestsPerDay) &&
  keylessRequestsPerDay > 0 &&
  Number.isFinite(keylessCreditsPerDay) &&
  keylessCreditsPerDay > 0;

function getUnparsedUploadRefsKey(teamId: string) {
  return `parse-upload-refs:${teamId}`;
}

function enableLocalUploadRefAdapter() {
  (config as any).ENV = "test";
  (config as any).PARSE_UPLOAD_STORAGE_DRIVER = "local";
}

async function mintUploadRef(
  owner: Identity,
  filename = "upload-ref.html",
  contentType = "text/html",
) {
  const init = await request(TEST_API_URL)
    .post("/v2/parse/upload-url")
    .set("Authorization", `Bearer ${owner.apiKey}`)
    .set("Content-Type", "application/json")
    .send({
      filename,
      contentType,
    });

  if (
    init.statusCode === 503 &&
    typeof init.body.code === "string" &&
    init.body.code.startsWith("PARSE_UPLOAD_")
  ) {
    if (parseUploadRefTestRequired) {
      expect(init.statusCode).toBe(200);
    }
    console.warn(
      `Skipping uploadRef storage-dependent test because ${TEST_API_URL} is not configured for parse upload refs: ${init.body.code}`,
    );
    return null;
  }

  expect(init.statusCode).toBe(200);
  expect(init.body.success).toBe(true);
  expect(init.body.data.uploadRef).toEqual(expect.any(String));
  return init.body.data as {
    uploadRef: string;
    uploadUrl: string;
    method: string;
    headers?: Record<string, string>;
    fields?: Record<string, string>;
    maxSizeBytes: number;
  };
}

async function mintRequiredUploadRef(
  owner: Identity,
  filename = "upload-ref.html",
  contentType = "text/html",
) {
  const init = await request(TEST_API_URL)
    .post("/v2/parse/upload-url")
    .set("Authorization", `Bearer ${owner.apiKey}`)
    .set("Content-Type", "application/json")
    .send({
      filename,
      contentType,
    });

  expect(init.statusCode, JSON.stringify(init.body)).toBe(200);
  expect(init.body.success).toBe(true);
  expect(init.body.data.uploadRef).toEqual(expect.any(String));
  return init.body.data as {
    uploadRef: string;
    uploadUrl: string;
    method: string;
    headers?: Record<string, string>;
    fields?: Record<string, string>;
    maxSizeBytes: number;
  };
}

async function uploadToMintedTarget(
  init: NonNullable<Awaited<ReturnType<typeof mintUploadRef>>>,
  content: string,
  filename = "upload-ref.html",
  contentType = "text/html",
) {
  if (init.method === "POST" && init.fields) {
    const form = new FormData();
    for (const key of Object.keys(init.fields).sort()) {
      form.append(key, init.fields[key]);
    }
    form.append("file", new Blob([content], { type: contentType }), filename);
    return await fetch(init.uploadUrl, {
      method: "POST",
      body: form,
    });
  }

  return await fetch(init.uploadUrl, {
    method: init.method || "PUT",
    headers: init.headers,
    body: content,
  });
}

function getLocalUploadRefSecret() {
  if (!config.PARSE_UPLOAD_REF_SECRET) {
    throw new Error(
      "PARSE_UPLOAD_REF_SECRET is required for uploadRef test signing",
    );
  }
  return config.PARSE_UPLOAD_REF_SECRET;
}

function resignUploadRefPayload(payload: Record<string, unknown>) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = crypto
    .createHmac("sha256", getLocalUploadRefSecret())
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function withUploadRefPayload(
  uploadRef: string,
  mutate: (payload: Record<string, any>) => void,
) {
  const [encodedPayload] = uploadRef.split(".");
  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  mutate(payload);
  return resignUploadRefPayload(payload);
}

function tamperUploadRefSignature(uploadRef: string) {
  const [encodedPayload, signature] = uploadRef.split(".");
  const replacement = signature.endsWith("A") ? "B" : "A";
  return `${encodedPayload}.${signature.slice(0, -1)}${replacement}`;
}

function decodeUploadRefPayload(uploadRef: string) {
  const [encodedPayload] = uploadRef.split(".");
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

async function waitForSingleRow<T>(
  fetcher: () => Promise<T | null>,
  timeoutMs: number = 10000,
  intervalMs: number = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await fetcher();
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

afterEach(() => {
  (config as any).PARSE_UPLOAD_STORAGE_DRIVER =
    originalParseUploadStorageDriver;
  (config as any).ENV = originalEnv;
});

beforeAll(async () => {
  identity = await idmux({
    name: "parse",
    concurrency: 100,
    credits: 1000000,
  });

  if (ALLOW_TEST_SUITE_WEBSITE) {
    const response = await fetch(`${TEST_SUITE_WEBSITE}/example.pdf`);
    pdfFixture = Buffer.from(await response.arrayBuffer());
  }
}, 10000 + scrapeTimeout);

describe("/v2/parse", () => {
  it(
    "parses an uploaded HTML file into markdown",
    async () => {
      const result = await parse(
        {
          options: {
            formats: ["markdown"],
          },
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(result.markdown).toContain("Parse HTML Upload Test");
      expect(result.metadata.creditsUsed).toBe(1);
      expect(result.metadata.sourceURL).toBe("upload.html");
    },
    scrapeTimeout,
  );

  it(
    "parses an upload-ref HTML file into markdown",
    async () => {
      const init = await mintUploadRef(identity);
      if (!init) return;

      expect(init.maxSizeBytes).toBe(50 * 1024 * 1024);

      const upload = await uploadToMintedTarget(init, htmlFixture);
      expect([200, 201, 204]).toContain(upload.status);

      const result = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          uploadRef: init.uploadRef,
          formats: ["markdown"],
        });

      expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data.markdown).toContain("Parse HTML Upload Test");
      expect(result.body.data.metadata.sourceURL).toBe("upload-ref.html");
    },
    scrapeTimeout,
  );

  it(
    "rejects oversized declared upload-ref sizes before signing",
    async () => {
      enableLocalUploadRefAdapter();

      const failure = await request(TEST_API_URL)
        .post("/v2/parse/upload-url")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          filename: "too-large.pdf",
          contentType: "application/pdf",
          declaredSizeBytes: 50 * 1024 * 1024 + 1,
        });

      expect(failure.statusCode).toBe(400);
      expect(failure.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it(
    "limits each team to 10 unparsed upload refs from the last 24 hours",
    async () => {
      enableLocalUploadRefAdapter();

      const capIdentity = await idmux({
        name: `parse-upload-ref-cap-${Date.now()}`,
        concurrency: 100,
        credits: 1000000,
      });
      const key = getUnparsedUploadRefsKey(capIdentity.teamId);
      await getRedisConnection().del(key);

      try {
        const oldScore = Date.now() - parseUploadUnparsedWindowMs - 1000;
        await getRedisConnection().zadd(
          key,
          ...Array.from({ length: 10 }).flatMap((_, i) => [
            oldScore,
            `old-${i}`,
          ]),
        );

        const first = await mintRequiredUploadRef(capIdentity, "cap-0.html");

        const refs = [first];
        for (let i = 1; i < 10; i++) {
          const init = await mintRequiredUploadRef(
            capIdentity,
            `cap-${i}.html`,
          );
          refs.push(init);
        }

        const rejected = await request(TEST_API_URL)
          .post("/v2/parse/upload-url")
          .set("Authorization", `Bearer ${capIdentity.apiKey}`)
          .set("Content-Type", "application/json")
          .send({
            filename: "cap-rejected.html",
            contentType: "text/html",
          });

        expect(rejected.statusCode).toBe(429);
        expect(rejected.body.success).toBe(false);
        expect(rejected.body.code).toBe("PARSE_UPLOAD_UNPARSED_LIMIT_REACHED");

        const upload = await uploadToMintedTarget(
          refs[0],
          htmlFixture,
          "cap-0.html",
        );
        expect([200, 201, 204]).toContain(upload.status);

        const parsed = await request(TEST_API_URL)
          .post("/v2/parse")
          .set("Authorization", `Bearer ${capIdentity.apiKey}`)
          .set("Content-Type", "application/json")
          .send({
            uploadRef: refs[0].uploadRef,
            formats: ["markdown"],
          });

        expect(parsed.statusCode, JSON.stringify(parsed.body)).toBe(200);
        expect(parsed.body.success).toBe(true);

        const acceptedAfterParse = await waitForSingleRow(async () => {
          const init = await request(TEST_API_URL)
            .post("/v2/parse/upload-url")
            .set("Authorization", `Bearer ${capIdentity.apiKey}`)
            .set("Content-Type", "application/json")
            .send({
              filename: "cap-accepted-after-parse.html",
              contentType: "text/html",
            });

          return init.statusCode === 200 ? init : null;
        });

        expect(acceptedAfterParse?.body.success).toBe(true);
      } finally {
        await getRedisConnection().del(key);
      }
    },
    scrapeTimeout,
  );

  it(
    "handles upload-ref signing without authentication according to keyless config",
    async () => {
      if (!config.USE_DB_AUTHENTICATION) {
        console.warn(
          "Skipping unauthenticated uploadRef signing test because authentication is bypassed when USE_DB_AUTHENTICATION is disabled",
        );
        return;
      }

      enableLocalUploadRefAdapter();

      const response = await request(TEST_API_URL)
        .post("/v2/parse/upload-url")
        .set("Content-Type", "application/json")
        .send({
          filename: "upload-ref-keyless.html",
          contentType: "text/html",
        });

      if (!keylessEnabled) {
        expect(response.statusCode).not.toBe(200);
        expect(response.body.success).toBe(false);
        return;
      }

      expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.uploadRef).toEqual(expect.any(String));
      expect(response.body.data.uploadUrl).toEqual(expect.any(String));

      const upload = await uploadToMintedTarget(
        response.body.data,
        htmlFixture,
        "upload-ref-keyless.html",
      );
      expect([200, 201, 204]).toContain(upload.status);

      const parsed = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Content-Type", "application/json")
        .send({
          uploadRef: response.body.data.uploadRef,
          formats: ["markdown"],
        });

      expect(parsed.statusCode, JSON.stringify(parsed.body)).toBe(200);
      expect(parsed.body.success).toBe(true);
      expect(parsed.body.data.markdown).toContain("Parse HTML Upload Test");
    },
    scrapeTimeout,
  );

  it(
    "rejects upload refs owned by another team",
    async () => {
      const init = await mintUploadRef(identity);
      if (!init) return;

      const canUseRealSecondTeam =
        !!config.IDMUX_URL && config.USE_DB_AUTHENTICATION === true;
      const otherIdentity = canUseRealSecondTeam
        ? await idmux({
            name: "parse-upload-ref-other-team",
            concurrency: 100,
            credits: 1000000,
          })
        : identity;

      if (canUseRealSecondTeam) {
        expect(otherIdentity.teamId).not.toBe(identity.teamId);
      }

      const uploadRef = canUseRealSecondTeam
        ? init.uploadRef
        : withUploadRefPayload(init.uploadRef, payload => {
            payload.teamId = "parse-upload-ref-other-team";
          });

      const failure = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${otherIdentity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          uploadRef,
          formats: ["markdown"],
        });

      expect(failure.statusCode).toBe(403);
      expect(failure.body.success).toBe(false);
      expect(failure.body.error).toMatch(/authenticated team/i);
    },
    scrapeTimeout,
  );

  it(
    "rejects tampered upload refs",
    async () => {
      const init = await mintUploadRef(identity);
      if (!init) return;

      const failure = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          uploadRef: tamperUploadRefSignature(init.uploadRef),
          formats: ["markdown"],
        });

      expect(failure.statusCode).toBe(400);
      expect(failure.body.success).toBe(false);
      expect(failure.body.error).toMatch(/signature/i);
    },
    scrapeTimeout,
  );

  it(
    "rejects expired upload refs",
    async () => {
      const init = await mintUploadRef(identity);
      if (!init) return;

      const payload = decodeUploadRefPayload(init.uploadRef);
      if (payload.driver !== "local" && !config.PARSE_UPLOAD_REF_SECRET) {
        console.warn(
          "Skipping uploadRef expiry test because the configured server signing secret is not available to this test process",
        );
        return;
      }

      const expiredUploadRef = withUploadRefPayload(init.uploadRef, payload => {
        payload.expiresAt = Date.now() - 1000;
      });

      const failure = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          uploadRef: expiredUploadRef,
          formats: ["markdown"],
        });

      expect(failure.statusCode).toBe(400);
      expect(failure.body.success).toBe(false);
      expect(failure.body.error).toMatch(/expired/i);
    },
    scrapeTimeout,
  );

  it(
    "mints upload refs for xhtml files accepted by parse",
    async () => {
      const init = await mintUploadRef(
        identity,
        "upload-ref.xhtml",
        "application/xhtml+xml",
      );
      if (!init) return;

      expect(init.uploadRef).toEqual(expect.any(String));
    },
    scrapeTimeout,
  );

  it(
    "parses an uploaded DOCX file into markdown",
    async () => {
      const result = await parse(
        {
          options: {
            formats: ["markdown"],
          },
          file: {
            content: Buffer.from(DOCX_FIXTURE_BASE64, "base64"),
            filename: "upload.docx",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        },
        identity,
      );

      expect(result.markdown).toMatch(/Parse DOCX Upload Test/i);
      expect(result.metadata.creditsUsed).toBe(1);
    },
    scrapeTimeout,
  );

  describeIf(ALLOW_TEST_SUITE_WEBSITE)("PDF upload parser", () => {
    it(
      "parses an uploaded PDF file",
      async () => {
        expect(pdfFixture).not.toBeNull();

        const result = await parse(
          {
            options: {
              formats: ["markdown"],
              parsers: ["pdf"],
            },
            file: {
              content: pdfFixture!,
              filename: "upload.pdf",
              contentType: "application/pdf",
            },
          },
          identity,
        );

        expect(result.markdown).toContain("PDF Test File");
        expect(result.metadata.numPages).toBeGreaterThan(0);
      },
      scrapeTimeout * 2,
    );
  });

  describeIf(ALLOW_TEST_SUITE_WEBSITE && !!config.FIRE_PDF_BASE_URL)(
    "PDF upload physical page markdown",
    () => {
      it(
        "returns physical pages for an uploaded PDF",
        async () => {
          expect(pdfFixture).not.toBeNull();

          const result = await parse(
            {
              options: {
                formats: ["markdown"],
                parsers: [{ type: "pdf", mode: "auto", pageMarkdown: true }],
              },
              file: {
                content: pdfFixture!,
                filename: "upload.pdf",
                contentType: "application/pdf",
              },
            },
            identity,
          );

          expect(result.markdown).toContain("PDF Test File");
          expect(result.pages).toHaveLength(result.metadata.numPages!);
          result.pages?.forEach((page, index) => {
            expect(page).toEqual(
              expect.objectContaining({
                pageNumber: index + 1,
                markdown: expect.any(String),
              }),
            );
          });
        },
        scrapeTimeout * 3,
      );
    },
  );

  it(
    "returns a validation error when file is missing",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
          },
        },
        identity,
      );

      expect(failure.code).toBe("BAD_REQUEST");
      expect(failure.error).toContain("Missing file upload");
    },
    scrapeTimeout,
  );

  it(
    "returns a validation error for invalid options JSON",
    async () => {
      const failure = await parseWithFailure(
        {
          rawOptions: "{invalid_json",
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("BAD_REQUEST");
      expect(failure.error).toContain("Invalid JSON");
    },
    scrapeTimeout,
  );

  it(
    "returns unsupported file type errors",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
          },
          file: {
            content: Buffer.from("not-an-image"),
            filename: "upload.png",
            contentType: "image/png",
          },
        },
        identity,
      );

      expect(failure.code).toBe("UNSUPPORTED_FILE_TYPE");
      expect(failure.error).toContain("Unsupported upload type");
    },
    scrapeTimeout,
  );

  it(
    "logs parse metadata into the parses table",
    async () => {
      if (!config.USE_DB_AUTHENTICATION) return;

      const filename = `parse-log-${Date.now()}.html`;
      await parse(
        {
          options: {
            formats: ["markdown"],
          },
          file: {
            content: htmlFixture,
            filename,
            contentType: "text/html",
          },
        },
        identity,
      );

      const requestLog = await waitForSingleRow<{ id: string }>(async () => {
        const data = await db
          .select({ id: schema.requests.id })
          .from(schema.requests)
          .where(
            and(
              eq(schema.requests.team_id, identity.teamId),
              eq(schema.requests.kind, "parse"),
              eq(schema.requests.target_hint, filename),
            ),
          )
          .orderBy(desc(schema.requests.created_at))
          .limit(1);
        return data[0] ?? null;
      });

      expect(requestLog).not.toBeNull();

      const parseLog = await waitForSingleRow<{
        request_id: string;
        url: string;
      }>(async () => {
        const data = await db
          .select({
            request_id: schema.parses.request_id,
            url: schema.parses.url,
          })
          .from(schema.parses)
          .where(eq(schema.parses.request_id, requestLog!.id))
          .orderBy(desc(schema.parses.created_at))
          .limit(1);
        return data[0] ?? null;
      });

      expect(parseLog).not.toBeNull();
      expect(parseLog!.request_id).toBe(requestLog!.id);
      expect(parseLog!.url).toContain(
        `https://parse.firecrawl.dev/uploads/${encodeURIComponent(filename)}`,
      );

      const scrapeRows = await db
        .select({ id: schema.scrapes.id })
        .from(schema.scrapes)
        .where(eq(schema.scrapes.request_id, requestLog!.id))
        .limit(1);
      expect(scrapeRows).toHaveLength(0);
    },
    scrapeTimeout,
  );

  it(
    "rejects parse-only unsupported options",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
            actions: [{ type: "wait", milliseconds: 250 }],
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support actions");
    },
    scrapeTimeout,
  );

  it(
    "rejects changeTracking format for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown", { type: "changeTracking" }],
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support change tracking");
    },
    scrapeTimeout,
  );

  it(
    "rejects waitFor option for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
            waitFor: 1000,
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support waitFor");
    },
    scrapeTimeout,
  );

  it(
    "rejects location option for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
            location: { country: "US" },
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support location");
    },
    scrapeTimeout,
  );

  it(
    "rejects mobile option for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
            mobile: true,
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support mobile");
    },
    scrapeTimeout,
  );

  it(
    "rejects non-basic/auto proxy for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown"],
            proxy: "stealth",
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("proxy");
    },
    scrapeTimeout,
  );

  it(
    "rejects screenshot format for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown", { type: "screenshot" }],
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support screenshot");
    },
    scrapeTimeout,
  );

  it(
    "rejects branding format for parse uploads",
    async () => {
      const failure = await parseWithFailure(
        {
          options: {
            formats: ["markdown", { type: "branding" }],
          } as any,
          file: {
            content: htmlFixture,
            filename: "upload.html",
            contentType: "text/html",
          },
        },
        identity,
      );

      expect(failure.code).toBe("PARSE_UNSUPPORTED_OPTIONS");
      expect(failure.error).toContain("do not support branding");
    },
    scrapeTimeout,
  );

  describeIf(TEST_PRODUCTION || HAS_AI)("AI format parse tests", () => {
    it(
      "parses with json format (LLM extraction)",
      async () => {
        const result = await parse(
          {
            options: {
              formats: [
                "markdown",
                {
                  type: "json",
                  prompt: "Extract the heading text",
                  schema: {
                    type: "object",
                    properties: {
                      heading: { type: "string" },
                    },
                    required: ["heading"],
                  },
                },
              ],
            } as any,
            file: {
              content: htmlFixture,
              filename: "upload.html",
              contentType: "text/html",
            },
          },
          identity,
        );

        expect(result.json).toBeDefined();
        expect(result.json).not.toBeNull();
      },
      scrapeTimeout,
    );

    it(
      "parses with summary format",
      async () => {
        const result = await parse(
          {
            options: {
              formats: ["markdown", { type: "summary" }],
            } as any,
            file: {
              content: htmlFixture,
              filename: "upload.html",
              contentType: "text/html",
            },
          },
          identity,
        );

        expect(result.summary).toBeDefined();
        expect(typeof result.summary).toBe("string");
      },
      scrapeTimeout,
    );
  });
});
