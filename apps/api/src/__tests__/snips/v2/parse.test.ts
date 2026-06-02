import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { idmux, Identity, parse, parseWithFailure, scrapeTimeout } from "./lib";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { config } from "../../../config";

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
