import type { Logger } from "winston";
import { z, ZodError } from "zod";
import * as Sentry from "@sentry/node";
import { fetch, FormData, Agent } from "undici";
import dns from "dns";
import { MockState, saveMock } from "./mock";
import { config } from "../../../config";
import { cacheableLookup } from "./cacheable-lookup";
import { AbortManagerThrownError } from "./abort-manager";

const fireEngineURL = config.FIRE_ENGINE_BETA_URL ?? "<mock-fire-engine-url>";
const playwrightURL =
  config.PLAYWRIGHT_MICROSERVICE_URL ?? "<mock-playwright-url>";

type Method = "GET" | "POST" | "DELETE" | "PUT";

type RobustFetchParams<Schema extends z.Schema<any>> = {
  url: string;
  logger: Logger;
  method: Method;
  body?: any;
  headers?: Record<string, string>;
  schema?: Schema;
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

const agentCached = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { lookup: cacheableLookup.lookup },
});
const agentPlain = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { lookup: dns.lookup },
});

type RawResponse = { status: number; headers: Headers; body: string };

function redactBody(body: any): any {
  if (body?.input?.file_content !== undefined) {
    return { ...body, input: { ...body.input, file_content: undefined } };
  }
  if (body?.pdf !== undefined) {
    return { ...body, pdf: undefined };
  }
  return body;
}

function mockResponseFor(
  mock: MockState,
  url: string,
  method: Method,
  body: any,
): RawResponse {
  const makeId = (x: { url: string; method: string; body?: any }) => {
    let u = x.url;
    if (u.startsWith(fireEngineURL)) {
      u = u.replace(fireEngineURL, "<fire-engine>");
    } else if (u.startsWith(playwrightURL)) {
      u = u.replace(playwrightURL, "<playwright>");
    }
    let out = u + ";" + x.method;
    if (u.startsWith("<fire-engine>") && x.method === "POST") {
      out += "f-e;" + x.body?.engine + ";" + x.body?.url;
    } else if (u.startsWith("<playwright>") && x.method === "POST") {
      out += "pw;" + x.body?.url;
    }
    return out;
  };
  const id = makeId({ url, method, body });
  const matches = mock.requests
    .filter(x => makeId(x.options) === id)
    .sort((a, b) => a.time - b.time);
  const i = mock.tracker[id] ?? 0;
  mock.tracker[id] = i + 1;
  if (!matches[i]) {
    throw new Error("Failed to mock request -- no mock targets found.");
  }
  return {
    ...matches[i].result,
    headers: new Headers(matches[i].result.headers),
  };
}

export async function robustFetch<
  Schema extends z.Schema<any>,
  Output = z.infer<Schema>,
>(params: RobustFetchParams<Schema>): Promise<Output> {
  const {
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
  } = params;

  abort?.throwIfAborted();

  const logParams = { ...params, body: redactBody(body), logger: undefined };
  const retry = () =>
    robustFetch<Schema, Output>({
      ...params,
      requestId,
      tryCount: tryCount - 1,
    });

  let response: RawResponse;

  if (mock === null) {
    try {
      const isForm = body instanceof FormData;
      const res = await fetch(url, {
        method,
        headers: {
          ...(isForm
            ? {}
            : body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          ...(headers ?? {}),
        },
        signal: abort,
        dispatcher: useCacheableLookup ? agentCached : agentPlain,
        ...(isForm
          ? { body }
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
      });
      response = {
        status: res.status,
        headers: res.headers,
        body: await res.text(),
      };
    } catch (error) {
      if (error instanceof AbortManagerThrownError) throw error;
      if (ignoreFailure) return null as Output;

      Sentry.captureException(error);
      const msg =
        tryCount > 1
          ? `Request failed, trying ${tryCount - 1} more times`
          : "Request failed";
      logger.debug(msg, { params: logParams, error, requestId });
      if (tryCount > 1) return retry();
      throw new Error("Request failed", {
        cause: { params: logParams, requestId, error },
      });
    }

    if (ignoreResponse) return null as Output;
    await saveMock(
      { ...params, logger: undefined, schema: undefined, headers: undefined },
      response,
    );
  } else {
    if (ignoreResponse) return null as Output;
    response = mockResponseFor(mock, url, method, body);
  }

  if (response.status >= 300 && !ignoreFailureStatus) {
    const responseLog = { status: response.status, body: response.body };
    const msg =
      tryCount > 1
        ? `Request sent failure status, trying ${tryCount - 1} more times`
        : "Request sent failure status";
    logger.debug(msg, { params: logParams, response: responseLog, requestId });
    if (tryCount > 1) {
      if (tryCooldown !== undefined) {
        await new Promise(r => setTimeout(r, tryCooldown));
      }
      return retry();
    }
    throw new Error("Request sent failure status", {
      cause: { params: logParams, response: responseLog, requestId },
    });
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
      cause: { params: logParams, response, requestId },
    });
  }

  if (schema) {
    try {
      data = schema.parse(data);
    } catch (error) {
      const label =
        error instanceof ZodError
          ? "Response does not match provided schema"
          : "Parsing response with provided schema failed";
      logger.debug(label, {
        params: logParams,
        response: { status: response.status, body: response.body },
        requestId,
        error,
        schema,
      });
      throw new Error(label, {
        cause: { params: logParams, response, requestId, error, schema },
      });
    }
  }

  return data;
}
