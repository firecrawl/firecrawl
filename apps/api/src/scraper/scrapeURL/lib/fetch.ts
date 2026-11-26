import type { Logger } from "winston";
import type { z } from "zod";
import { ZodError } from "zod";
import type { MockState } from "./mock";
import { saveMock } from "./mock";
import type { RequestInit, Response } from "undici";
import { fetch, FormData, Agent, Headers as UndiciHeaders } from "undici";
import { cacheableLookup } from "./cacheableLookup";
import dns from "node:dns";
import { AbortManagerThrownError } from "./abortManager";
import { isJsonObject } from "../../../lib/json-types";
import type { JsonObject, JsonValue } from "../../../lib/json-types";

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

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(
      (item: unknown) => item === undefined || isJsonValue(item),
    );
  }
  return isJsonObject(value);
}

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
  if (!isJsonObject(action)) {
    return action;
  }
  const redacted: JsonObject = { ...action };
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
  if (body === undefined || body instanceof FormData) {
    return body;
  }
  if (!isJsonObject(body)) {
    return isJsonValue(body) ? body : undefined;
  }
  const copy: JsonObject = { ...body };
  if (isJsonObject(body.headers)) {
    copy.headers = redactHeaderObject(body.headers);
  }
  if (Array.isArray(body.actions)) {
    copy.actions = body.actions.map(redactAction);
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
  if (isJsonObject(body)) {
    if (isJsonObject(body.input)) {
      return redactRequestBodyForLog({
        ...body,
        input: {
          ...body.input,
          file_content: undefined,
        },
      });
    }
    if (body.pdf) {
      return redactRequestBodyForLog({
        ...body,
        pdf: undefined,
      });
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
): Promise<JsonValue>;
export async function robustFetch<Schema extends z.ZodType = z.ZodType>(
  params: RobustFetchParams<Schema>,
): Promise<z.infer<Schema> | JsonValue>;
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
}: RobustFetchParams<Schema>): Promise<z.infer<Schema> | JsonValue> {
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
        const bodyObj = isJsonObject(request.body) ? request.body : undefined;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
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
    try {
      return schema.parse(parsed);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        logger.debug("Response does not match provided schema", {
          params: logParams,
          response: { status: response.status, body: response.body },
          requestId,
          error,
          schema,
        });
        throw new Error("Response does not match provided schema", {
          cause: error,
        });
      } else {
        logger.debug("Parsing response with provided schema failed", {
          params: logParams,
          response: { status: response.status, body: response.body },
          requestId,
          error,
          schema,
        });
        throw new Error("Parsing response with provided schema failed", {
          cause: error,
        });
      }
    }
  }

  return isJsonValue(parsed) ? parsed : null;
}
