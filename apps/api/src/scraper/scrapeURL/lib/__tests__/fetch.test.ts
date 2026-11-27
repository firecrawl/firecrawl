import { createLogger } from "winston";
import { z } from "zod";
import { redactHeaders, redactRequestBodyForLog, robustFetch } from "../fetch";
import type { MockState } from "../mock";

const secretHeaders = {
  Authorization: "Bearer secret-value",
  "Proxy-Authorization": "Basic secret-value",
  Cookie: "session=secret-value",
  "Set-Cookie": "session=secret-value",
  "x-api-key": "secret-value",
  "api-key": "secret-value",
  "X-Auth-Token": "secret-value",
  "X-Client-Secret": "secret-value",
  "X-Password": "secret-value",
  "X-Credential": "secret-value",
  "X-Session-Id": "secret-value",
  x_api_key: "secret-value",
  "X-Signature": "secret-value",
  "X-JWT": "secret-value",
  "Content-Type": "application/json",
  "User-Agent": "firecrawl",
};

function makeLogger() {
  const logger = createLogger({ silent: true });
  const debugSpy = vi.spyOn(logger, "debug");
  vi.spyOn(logger, "info");
  vi.spyOn(logger, "warn");
  vi.spyOn(logger, "error");
  vi.spyOn(logger, "child").mockReturnValue(logger);
  return { logger, debugSpy };
}

function mockWith(status: number, body: string): MockState {
  return {
    requests: [
      {
        time: 0,
        options: { url: "https://upstream.test/run", method: "POST" },
        result: { status, headers: {}, body },
      },
    ],
    tracker: {},
  };
}

const fetchErrorCauseSchema = z.object({
  params: z.object({
    headers: z.record(z.string(), z.string()).optional(),
    body: z
      .object({
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        actions: z.array(z.object({ type: z.string().optional() })).optional(),
      })
      .optional(),
  }),
});

type FetchErrorCauseParams = z.infer<typeof fetchErrorCauseSchema>["params"];

async function captureCause(
  promise: Promise<unknown>,
): Promise<{ raw: unknown; params: FetchErrorCauseParams }> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const parsed = fetchErrorCauseSchema.safeParse(error.cause);
      if (parsed.success) {
        return { raw: error.cause, params: parsed.data.params };
      }
    }
    throw new Error(
      "expected robustFetch to throw an Error with structured cause",
      { cause: error },
    );
  }
  throw new Error("expected robustFetch to throw");
}

describe("redactHeaders", () => {
  it("redacts credential headers case-insensitively and keeps the rest", () => {
    expect(redactHeaders(secretHeaders)).toEqual({
      Authorization: "[REDACTED]",
      "Proxy-Authorization": "[REDACTED]",
      Cookie: "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "api-key": "[REDACTED]",
      "X-Auth-Token": "[REDACTED]",
      "X-Client-Secret": "[REDACTED]",
      "X-Password": "[REDACTED]",
      "X-Credential": "[REDACTED]",
      "X-Session-Id": "[REDACTED]",
      x_api_key: "[REDACTED]",
      "X-Signature": "[REDACTED]",
      "X-JWT": "[REDACTED]",
      "Content-Type": "application/json",
      "User-Agent": "firecrawl",
    });
  });

  it("passes undefined through", () => {
    expect(redactHeaders(undefined)).toBeUndefined();
  });
});

const secretActions = [
  { type: "wait", milliseconds: 1000 },
  { type: "click", selector: "#password", all: false },
  { type: "write", text: "secret-value" },
  { type: "press", key: "Enter" },
  {
    type: "executeJavascript",
    script: "window.token = 'secret-value'",
    metadata: { __firecrawl_internal: true },
  },
];

describe("redactRequestBodyForLog", () => {
  it("redacts credential headers and secret-carrying action payloads", () => {
    const body = {
      url: "https://example.com/login",
      engine: "chrome-cdp",
      timeout: 30_000,
      mobileProxy: true,
      headers: secretHeaders,
      actions: secretActions,
    };

    const redacted = redactRequestBodyForLog(body);

    expect(redacted).toEqual({
      url: "https://example.com/login",
      engine: "chrome-cdp",
      timeout: 30_000,
      mobileProxy: true,
      headers: redactHeaders(secretHeaders),
      actions: [
        { type: "wait", milliseconds: 1000 },
        { type: "click", selector: "#password", all: false },
        { type: "write", text: "[REDACTED]" },
        { type: "press", key: "Enter" },
        {
          type: "executeJavascript",
          script: "[REDACTED]",
          metadata: { __firecrawl_internal: true },
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
  });

  it("does not mutate the body that is sent", () => {
    const body = {
      headers: { Authorization: "Bearer secret-value" },
      actions: [{ type: "write", text: "secret-value" }],
    };

    redactRequestBodyForLog(body);

    expect(body.headers.Authorization).toBe("Bearer secret-value");
    expect(body.actions[0].text).toBe("secret-value");
  });

  it("passes through bodies without headers or actions", () => {
    const body = { url: "https://example.com", engine: "tlsclient" };
    expect(redactRequestBodyForLog(body)).toEqual(body);
    expect(redactRequestBodyForLog(undefined)).toBeUndefined();
    expect(redactRequestBodyForLog("raw")).toBe("raw");
  });
});

describe("robustFetch error logging", () => {
  it.each([
    ["a failure status", mockWith(500, "{}"), undefined],
    ["malformed JSON", mockWith(200, "not json"), undefined],
    [
      "a schema mismatch",
      mockWith(200, JSON.stringify({ other: 1 })),
      z.object({ id: z.string() }),
    ],
  ])(
    "never logs or throws credential headers on %s",
    async (_, mock, schema) => {
      const { logger, debugSpy } = makeLogger();

      const { raw, params } = await captureCause(
        robustFetch({
          url: "https://upstream.test/run",
          method: "POST",
          headers: secretHeaders,
          body: { input: { file_content: "BASE64" } },
          logger,
          mock,
          schema,
        }),
      );

      const serialized = JSON.stringify([raw, debugSpy.mock.calls]);
      expect(serialized).not.toContain("secret-value");
      expect(params.headers?.Authorization).toBe("[REDACTED]");
      expect(params.headers?.["User-Agent"]).toBe("firecrawl");
    },
  );

  it("redacts headers forwarded inside the request body", async () => {
    const { logger, debugSpy } = makeLogger();

    const { raw, params } = await captureCause(
      robustFetch({
        url: "https://upstream.test/run",
        method: "POST",
        body: { url: "https://example.com", headers: secretHeaders },
        logger,
        mock: mockWith(500, "{}"),
      }),
    );

    const serialized = JSON.stringify([raw, debugSpy.mock.calls]);
    expect(serialized).not.toContain("secret-value");
    expect(params.body?.url).toBe("https://example.com");
    expect(params.body?.headers?.["User-Agent"]).toBe("firecrawl");
  });

  it("redacts action payloads forwarded inside the request body", async () => {
    const { logger, debugSpy } = makeLogger();

    const { raw, params } = await captureCause(
      robustFetch({
        url: "https://upstream.test/run",
        method: "POST",
        body: { url: "https://example.com", actions: secretActions },
        logger,
        mock: mockWith(500, "{}"),
      }),
    );

    const serialized = JSON.stringify([raw, debugSpy.mock.calls]);
    expect(serialized).not.toContain("secret-value");
    expect((params.body?.actions ?? []).map(a => a.type)).toEqual(
      secretActions.map(a => a.type),
    );
  });
});
