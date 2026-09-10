import { fetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config";
import { ExchangeProxyError, forwardToExchange } from "./exchange-proxy";

vi.mock("undici", () => ({
  fetch: vi.fn(),
  Agent: class {
    constructor(_opts: unknown) {}
  },
}));

const fetchMock = vi.mocked(fetch);

function upstream(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as any;
}

describe("forwardToExchange", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    config.FIRE_EXCHANGE_URL = "https://exchange.example/";
  });

  it("sets the team from the authenticated caller and never from the request", async () => {
    fetchMock.mockResolvedValueOnce(
      upstream(200, { ok: true }, { "x-request-id": "rid-1" }),
    );

    const result = await forwardToExchange({
      teamId: "team_a",
      method: "POST",
      path: "/v1/retrieve",
      body: { requests: [] },
      timeoutMs: 1_000,
      requestId: "rid-1",
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, any];
    expect(url).toBe("https://exchange.example/v1/retrieve");
    expect(init.headers).toMatchObject({
      "x-exchange-team-id": "team_a",
      "x-request-id": "rid-1",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ requests: [] }));
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true },
      requestId: "rid-1",
    });
  });

  it("sends no body on GET", async () => {
    fetchMock.mockResolvedValueOnce(upstream(200, { capabilities: [] }));
    await forwardToExchange({
      teamId: "t",
      method: "GET",
      path: "/v1/discover?q=x",
      timeoutMs: 1_000,
    });
    expect((fetchMock.mock.calls[0]![1] as any).body).toBeUndefined();
  });

  it("is unconfigured without an Exchange URL, before any call", async () => {
    config.FIRE_EXCHANGE_URL = "";
    await expect(
      forwardToExchange({
        teamId: "t",
        method: "GET",
        path: "/v1/discover",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a timeout as a timeout and anything else as unreachable", async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException("aborted", "TimeoutError"),
    );
    await expect(
      forwardToExchange({
        teamId: "t",
        method: "GET",
        path: "/v1/discover",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const error = await forwardToExchange({
      teamId: "t",
      method: "GET",
      path: "/v1/discover",
      timeoutMs: 1,
    }).catch(e => e);
    expect(error).toBeInstanceOf(ExchangeProxyError);
    expect(error.kind).toBe("unreachable");
  });

  it("forwards the method verbatim, including PUT and DELETE", async () => {
    for (const method of ["PUT", "DELETE", "GET", "POST"]) {
      fetchMock.mockResolvedValueOnce(upstream(200, { ok: true }));
      await forwardToExchange({
        teamId: "t",
        method,
        path: "/v1/supply/x",
        timeoutMs: 1,
        body: { a: 1 },
      });
      const init = fetchMock.mock.calls.at(-1)![1] as any;
      expect(init.method).toBe(method);
      expect(init.body === undefined).toBe(method === "GET");
    }
  });

  it("treats undici's own timeout codes as timeouts", async () => {
    for (const code of [
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]) {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(
        forwardToExchange({
          teamId: "t",
          method: "GET",
          path: "/v1/x",
          timeoutMs: 1,
        }),
      ).rejects.toMatchObject({ kind: "timeout" });
    }
  });

  it("maps a failure while reading the body the same way as one before it", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw Object.assign(new Error("body"), {
          code: "UND_ERR_BODY_TIMEOUT",
        });
      },
    } as any);
    await expect(
      forwardToExchange({
        teamId: "t",
        method: "GET",
        path: "/v1/x",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });

    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new Error("socket hang up");
      },
    } as any);
    await expect(
      forwardToExchange({
        teamId: "t",
        method: "GET",
        path: "/v1/x",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("relays a non-JSON body as text rather than failing", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 502,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "bad gateway",
    } as any);
    const result = await forwardToExchange({
      teamId: "t",
      method: "GET",
      path: "/v1/x",
      timeoutMs: 1,
    });
    expect(result).toMatchObject({ status: 502, body: "bad gateway" });
  });
});
