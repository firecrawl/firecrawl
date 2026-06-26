import { Logger } from "winston";
import { z, ZodError } from "zod";
import * as Sentry from "@sentry/node";
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
  abort?: AbortSignal;
  useCacheableLookup?: boolean;
};

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

  // omit pdf file content from logs
  const logParams = {
    ...params,
    body: body?.input
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
        : body,
    logger: undefined,
  };

  let response: {
    status: number;
    headers: Headers;
    body: string;
  };

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
      Sentry.captureException(error);
      if (tryCount > 1) {
        logger.debug(
          "Request failed, trying " + (tryCount - 1) + " more times",
          { params: logParams, error, requestId },
        );
        return await robustFetch({
          ...params,
          requestId,
          tryCount: tryCount - 1,
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
