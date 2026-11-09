import { Logger } from "winston";
import { z, ZodError } from "zod";
import { MockState, saveMock } from "./mock";
import { fireEngineURL } from "../engines/fire-engine/scrape";
import { fetch, Response, FormData, Agent } from "undici";
import { cacheableLookup } from "./cacheableLookup";
import dns from "dns";
import { AbortManagerThrownError } from "./abortManager";

type RobustFetchParams<Schema extends z.Schema<any>> = {
  url: string;
  logger: Logger;
  method: "GET" | "POST" | "DELETE" | "PUT";
  body?: any;
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

// Logs only, so err on the side of redacting: any header whose name looks like
// it could carry a credential (Authorization, X-Auth-*, Cookie, X-Password,
// X-Session-Id, X-Api-Key, X-Signature, ...).
const SENSITIVE_HEADER =
  /auth|cookie|api[-_]?key|token|secret|passw|credential|session|signature|jwt/i;

export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
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

/**
 * A copy of a scrape request body that is safe to log: credential headers and
 * secret-carrying action payloads are replaced with "[REDACTED]".
 */
export function redactRequestBodyForLog<T>(body: T): T {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body instanceof FormData
  ) {
    return body;
  }
  const { headers, actions } = body as {
    headers?: unknown;
    actions?: unknown;
  };
  return {
    ...body,
    ...(headers !== null && typeof headers === "object"
      ? { headers: redactHeaders(headers as Record<string, string>) }
      : {}),
    ...(Array.isArray(actions)
      ? {
          actions: actions.map(action => {
            if (action === null || typeof action !== "object") return action;
            const redacted: Record<string, unknown> = { ...action };
            for (const field of SENSITIVE_ACTION_FIELDS) {
              if (field in redacted) redacted[field] = "[REDACTED]";
            }
            return redacted;
          }),
        }
      : {}),
  };
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

export async function robustFetch<
  Schema extends z.Schema<any>,
  Output = z.infer<Schema>,
>({
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
}: RobustFetchParams<Schema>): Promise<Output> {
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
  const logBody = body?.input
    ? {
        ...body,
        input: {
          ...body.input,
          file_content: undefined,
        },
      }
    : body?.pdf
      ? {
          ...body,
          pdf: undefined,
        }
      : body;
  const logParams = {
    ...params,
    headers: redactHeaders(headers),
    body: redactRequestBodyForLog(logBody),
    logger: undefined,
  };

  let response: {
    status: number;
    headers: Headers;
    body: string;
  };

  if (mock === null) {
    let request: Response;
    try {
      request = await fetch(url, {
        method,
        headers: {
          ...(body instanceof FormData
            ? {}
            : body !== undefined
              ? {
                  "Content-Type": "application/json",
                }
              : {}),
          ...(headers !== undefined ? headers : {}),
        },
        signal: abort,
        dispatcher: useCacheableLookup ? robustAgent : robustAgentNoLookup,
        ...(body instanceof FormData
          ? {
              body,
            }
          : body !== undefined
            ? {
                body: JSON.stringify(body),
              }
            : {}),
      });
    } catch (error) {
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
            cause: {
              params: logParams,
              requestId,
              error,
            },
          });
        }
      } else {
        return null as Output;
      }
    }

    if (ignoreResponse === true) {
      return null as Output;
    }

    const resp = await request.text();
    response = {
      status: request.status,
      headers: request.headers,
      body: resp, // NOTE: can this throw an exception?
    };
  } else {
    if (ignoreResponse === true) {
      return null as Output;
    }

    const makeRequestTypeId = (
      request: (typeof mock)["requests"][number]["options"],
    ) => {
      let trueUrl = request.url.startsWith(fireEngineURL)
        ? request.url.replace(fireEngineURL, "<fire-engine>")
        : request.url;

      let out = trueUrl + ";" + request.method;
      if (trueUrl.startsWith("<fire-engine>") && request.method === "POST") {
        out += "f-e;" + request.body?.engine + ";" + request.body?.url;
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

    response = {
      ...matchingMocks[nextI].result,
      headers: new Headers(matchingMocks[nextI].result.headers),
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

  let data: Output;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
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
      data = schema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        logger.debug("Response does not match provided schema", {
          params: logParams,
          response: { status: response.status, body: response.body },
          requestId,
          error,
          schema,
        });
        throw new Error("Response does not match provided schema", {
          cause: {
            params: logParams,
            response,
            requestId,
            error,
            schema,
          },
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
          cause: {
            params: logParams,
            response,
            requestId,
            error,
            schema,
          },
        });
      }
    }
  }

  return data;
}
