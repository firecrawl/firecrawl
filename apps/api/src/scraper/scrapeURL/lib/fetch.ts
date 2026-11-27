import type { Logger } from "winston";
import { z } from "zod";
import type { MockState } from "./mock";
import { saveMock } from "./mock";
import type { RequestInit, Response } from "undici";
import { fetch, FormData, Agent, Headers as UndiciHeaders } from "undici";
import { cacheableLookup } from "./cacheableLookup";
import dns from "node:dns";
import { AbortManagerThrownError } from "./abortManager";
import { jsonValueSchema, parseJsonString } from "../../../lib/json-types";
import type { JsonObject, JsonValue } from "../../../lib/json-types";

const shallowPlainObjectSchema = z.custom<JsonObject>(
  value =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof FormData),
);

const fireEngineMockBodySchema = z.object({
  engine: jsonValueSchema.optional(),
  url: jsonValueSchema.optional(),
});

type RobustFetchParams<Schema extends z.ZodType> = {
  url: string;
  logger: Logger;
  method: "GET" | "POST" | "DELETE" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
  schema?: Schema;
  dontParseResponse?: boolean;
  ignoreResponse?: boolean;
  ignoreFailure?: boolean;
  ignoreFailureStatus?: boolean;
  requestId?: string;
  tryCount?: number;
  tryCooldown?: number;
  mock: MockState | null;
  abort?: AbortSignal;
  useCacheableLookup?: boolean;
};

type FetchResponsePayload = {
  status: number;
  headers: Headers;
  body: string;
};

// Logs only, so err on the side of redacting: any header whose name looks like
// it could carry a credential (Authorization, X-Auth-*, Cookie, X-Password,
// X-Session-Id, X-Api-Key, X-Signature, ...).
const SENSITIVE_HEADER =
  /auth|cookie|api[-_]?key|token|secret|passw|credential|session|signature|jwt/i;

export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER.test(name) ? "[REDACTED]" : value,
    ]),
  );
}

// Action fields that carry user-typed text or script bodies. `write` text can
// be a password; `executeJavascript` scripts can embed tokens (and the branding
// script is large), so neither belongs in logs.
const SENSITIVE_ACTION_FIELDS = ["text", "script"] as const;

function redactHeaderObject(headers: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADER.test(name) ? "[REDACTED]" : value;
  }
  return result;
}

function redactAction(action: JsonValue | undefined): JsonValue | undefined {
  const parsed = shallowPlainObjectSchema.safeParse(action);
  if (!parsed.success) {
    return action;
  }
  const redacted: JsonObject = { ...parsed.data };
  for (const field of SENSITIVE_ACTION_FIELDS) {
    if (Object.hasOwn(redacted, field)) {
      redacted[field] = "[REDACTED]";
    }
  }
  return redacted;
}

/**
 * A copy of a scrape request body that is safe to log: credential headers and
 * secret-carrying action payloads are replaced with "[REDACTED]".
 */
export function redactRequestBodyForLog(
  body: unknown,
): JsonValue | FormData | undefined {
  if (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    typeof body === "number" ||
    typeof body === "boolean" ||
    body instanceof FormData
  ) {
    return body;
  }
  const parsedObject = shallowPlainObjectSchema.safeParse(body);
  if (!parsedObject.success) {
    const parsedValue = jsonValueSchema.safeParse(body);
    return parsedValue.success ? parsedValue.data : undefined;
  }
  const copy: JsonObject = { ...parsedObject.data };
  const parsedHeaders = shallowPlainObjectSchema.safeParse(
    parsedObject.data.headers,
  );
  if (parsedHeaders.success) {
    copy.headers = redactHeaderObject(parsedHeaders.data);
  }
  if (Array.isArray(parsedObject.data.actions)) {
    copy.actions = parsedObject.data.actions.map(redactAction);
  }
  return copy;
}

function formatMockBodySegment(value: JsonValue | undefined): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function sanitizeBodyForLog(body: unknown): JsonValue | FormData | undefined {
  const parsedBody = shallowPlainObjectSchema.safeParse(body);
  if (parsedBody.success) {
    const parsedInput = shallowPlainObjectSchema.safeParse(
      parsedBody.data.input,
    );
    if (parsedInput.success) {
      const sanitizedInput: JsonObject = { ...parsedInput.data };
      delete sanitizedInput.file_content;
      return redactRequestBodyForLog({
        ...parsedBody.data,
        input: sanitizedInput,
      });
    }
    if (parsedBody.data.pdf) {
      const sanitizedBody: JsonObject = { ...parsedBody.data };
      delete sanitizedBody.pdf;
      return redactRequestBodyForLog(sanitizedBody);
    }
  }
  return redactRequestBodyForLog(body);
}

const robustAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: {
    lookup: cacheableLookup.lookup,
  },
});

const robustAgentNoLookup = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: {
    lookup: dns.lookup,
  },
});

export async function robustFetch<Schema extends z.ZodType>(
  params: RobustFetchParams<Schema> & {
    schema: Schema;
    ignoreResponse?: false;
    ignoreFailure?: false;
  },
): Promise<z.infer<Schema>>;
export async function robustFetch<Schema extends z.ZodType>(
  params: RobustFetchParams<Schema> & {
    schema: Schema;
  },
): Promise<z.infer<Schema> | null>;
export async function robustFetch(
  params: RobustFetchParams<never> & {
    schema?: undefined;
  },
): Promise<JsonValue | null>;
export async function robustFetch<Schema extends z.ZodType = z.ZodType>(
  params: RobustFetchParams<Schema>,
): Promise<z.infer<Schema> | JsonValue | null>;
export async function robustFetch<Schema extends z.ZodType = z.ZodType>({
  url,
  logger,
  method = "GET",
  body,
  headers,
  schema,
  ignoreResponse = false,
  ignoreFailure = false,
  ignoreFailureStatus = false,
  requestId = crypto.randomUUID(),
  tryCount = 1,
  tryCooldown,
  mock,
  abort,
  useCacheableLookup = true,
}: RobustFetchParams<Schema>): Promise<z.infer<Schema> | JsonValue | null> {
  abort?.throwIfAborted();

  const params = {
    url,
    logger,
    method,
    body,
    headers,
    schema,
    ignoreResponse,
    ignoreFailure,
    ignoreFailureStatus,
    tryCount,
    tryCooldown,
    abort,
  };

  // omit pdf file content and credentials from logs
  const logParams = {
    ...params,
    headers: redactHeaders(headers),
    body: sanitizeBodyForLog(body),
    logger: undefined,
  };

  let response: FetchResponsePayload;

  if (mock === null) {
    let request: Response;
    try {
      const requestHeaders = new UndiciHeaders();
      if (!(body instanceof FormData) && body !== undefined) {
        requestHeaders.set("Content-Type", "application/json");
      }
      if (headers !== undefined) {
        for (const [key, value] of Object.entries(headers)) {
          requestHeaders.set(key, value);
        }
      }
      const fetchInit: RequestInit = {
        method,
        headers: requestHeaders,
        signal: abort,
        dispatcher: useCacheableLookup ? robustAgent : robustAgentNoLookup,
      };
      if (body instanceof FormData) {
        fetchInit.body = body;
      } else if (body !== undefined) {
        fetchInit.body = JSON.stringify(body);
      }
      request = await fetch(url, fetchInit);
    } catch (error: unknown) {
      if (error instanceof AbortManagerThrownError) {
        throw error;
      } else if (!ignoreFailure) {
        if (tryCount > 1) {
          logger.debug(
            "Request failed, trying " + (tryCount - 1) + " more times",
            { params: logParams, error, requestId },
          );
          return await robustFetch({
            ...params,
            requestId,
            tryCount: tryCount - 1,
            mock,
          });
        } else {
          logger.debug("Request failed", {
            params: logParams,
            error,
            requestId,
          });
          throw new Error("Request failed", {
            cause: error,
          });
        }
      } else {
        return null;
      }
    }

    if (ignoreResponse === true) {
      return null;
    }

    const resp = await request.text();
    response = {
      status: request.status,
      headers: request.headers,
      body: resp, // NOTE: can this throw an exception?
    };
  } else {
    if (ignoreResponse === true) {
      return null;
    }

    const fireEngineBaseUrl =
      process.env.FIRE_ENGINE_BETA_URL || "<mock-fire-engine-url>";
    const makeRequestTypeId = (
      request: (typeof mock)["requests"][number]["options"],
    ) => {
      const trueUrl = request.url.startsWith(fireEngineBaseUrl)
        ? request.url.replace(fireEngineBaseUrl, "<fire-engine>")
        : request.url;

      let out = trueUrl + ";" + request.method;
      if (trueUrl.startsWith("<fire-engine>") && request.method === "POST") {
        const parsedBody = fireEngineMockBodySchema.safeParse(request.body);
        const bodyObj = parsedBody.success ? parsedBody.data : undefined;
        out +=
          "f-e;" +
          formatMockBodySegment(bodyObj?.engine) +
          ";" +
          formatMockBodySegment(bodyObj?.url);
      }
      return out;
    };

    const thisId = makeRequestTypeId(params);
    const matchingMocks = mock.requests
      .filter(x => makeRequestTypeId(x.options) === thisId)
      .sort((a, b) => a.time - b.time);
    const nextI = mock.tracker[thisId] ?? 0;
    mock.tracker[thisId] = nextI + 1;

    if (!matchingMocks[nextI]) {
      throw new Error("Failed to mock request -- no mock targets found.");
    }

    const mockResult = matchingMocks[nextI].result;
    response = {
      status: mockResult.status,
      body: mockResult.body,
      headers: new Headers(mockResult.headers),
    };
  }

  if (response.status >= 300 && !ignoreFailureStatus) {
    if (tryCount > 1) {
      logger.debug(
        "Request sent failure status, trying " + (tryCount - 1) + " more times",
        {
          params: logParams,
          response: { status: response.status, body: response.body },
          requestId,
        },
      );
      if (tryCooldown !== undefined) {
        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
          await new Promise<null>(resolve => {
            timeoutHandle = setTimeout(() => resolve(null), tryCooldown);
          });
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }
      return await robustFetch({
        ...params,
        requestId,
        tryCount: tryCount - 1,
        mock,
      });
    } else {
      logger.debug("Request sent failure status", {
        params: logParams,
        response: { status: response.status, body: response.body },
        requestId,
      });
      throw new Error("Request sent failure status", {
        cause: {
          params: logParams,
          response: { status: response.status, body: response.body },
          requestId,
        },
      });
    }
  }

  if (mock === null) {
    await saveMock(
      {
        ...params,
        logger: undefined,
        schema: undefined,
        headers: undefined,
      },
      response,
    );
  }

  let parsed: JsonValue;
  try {
    parsed = parseJsonString(response.body);
  } catch {
    logger.debug("Request sent malformed JSON", {
      params: logParams,
      response: { status: response.status, body: response.body },
      requestId,
    });
    throw new Error("Request sent malformed JSON", {
      cause: {
        params: logParams,
        response,
        requestId,
      },
    });
  }

  if (schema) {
    let parseResult: z.ZodSafeParseResult<z.infer<Schema>> | undefined;
    let parseFailure: unknown;
    let didThrow = false;
    try {
      parseResult = schema.safeParse(parsed);
    } catch (error: unknown) {
      didThrow = true;
      parseFailure = error;
    }

    if (didThrow) {
      logger.debug("Parsing response with provided schema failed", {
        params: logParams,
        response: { status: response.status, body: response.body },
        requestId,
        error: parseFailure,
        schema,
      });
      throw new Error("Parsing response with provided schema failed", {
        cause: {
          params: logParams,
          response,
          requestId,
          error: parseFailure,
          schema,
        },
      });
    }

    if (parseResult && !parseResult.success) {
      logger.debug("Response does not match provided schema", {
        params: logParams,
        response: { status: response.status, body: response.body },
        requestId,
        error: parseResult.error,
        schema,
      });
      throw new Error("Response does not match provided schema", {
        cause: {
          params: logParams,
          response,
          requestId,
          error: parseResult.error,
          schema,
        },
      });
    }

    if (parseResult) {
      return parseResult.data;
    }
  }

  return parsed;
}
