import { describe, expect, it } from "vitest";
import { feedbackTrace } from "./feedback-trace";

const lineage = {
  session_id: "sess_01HZX",
  session_source: "token",
  thread_id: "thread:42.a-b",
  thread_source: "client",
  objective: "Find the cheapest flight to Lisbon.",
};
const noLineage = {
  session_id: null,
  session_source: null,
  thread_id: null,
  thread_source: null,
  objective: null,
};

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function request(
  headers: Record<string, string>,
  auth: { hostedMcp?: boolean } = { hostedMcp: true },
) {
  return { headers, auth };
}

const trace = (value: unknown) =>
  feedbackTrace(request({ "x-firecrawl-mcp-lineage": encode(value) }));

describe("feedbackTrace", () => {
  it("returns the request id and the whole lineage of a hosted MCP call", () => {
    expect(
      feedbackTrace(
        request({
          "external-request-id": "0190a5d4-7b10-7cc3-98c4-0242ac120002",
          "x-firecrawl-mcp-lineage": encode(lineage),
        }),
      ),
    ).toEqual({
      external_request_id: "0190a5d4-7b10-7cc3-98c4-0242ac120002",
      ...lineage,
    });
  });

  it.each([false, undefined])(
    "ignores the lineage header when hostedMcp is %s",
    hostedMcp => {
      expect(
        feedbackTrace(
          request(
            {
              "external-request-id": "caller-op-7",
              "x-firecrawl-mcp-lineage": encode(lineage),
            },
            { hostedMcp },
          ),
        ),
      ).toEqual({ external_request_id: "caller-op-7", ...noLineage });
    },
  );

  it("returns nulls when no header is sent", () => {
    expect(feedbackTrace(request({}))).toEqual({
      external_request_id: null,
      ...noLineage,
    });
    expect(feedbackTrace({ headers: {} })).toEqual({
      external_request_id: null,
      ...noLineage,
    });
  });

  it("keeps a request id of 128 characters and drops a longer one", () => {
    expect(
      feedbackTrace(request({ "external-request-id": "a".repeat(128) }))
        .external_request_id,
    ).toBe("a".repeat(128));
    expect(
      feedbackTrace(request({ "external-request-id": "a".repeat(129) }))
        .external_request_id,
    ).toBeNull();
  });

  it.each([
    ["malformed base64", "%%%not-base64%%%"],
    ["a valid payload followed by other characters", `${encode(lineage)}%%%`],
    ["standard base64 that is not URL-safe", "eyJ4Ijoi+/8ifQ=="],
    ["base64 of text that is not JSON", encode("x").slice(0, 2)],
    ["a JSON string", encode("session")],
    ["a JSON number", encode(7)],
    ["JSON null", encode(null)],
    ["a JSON array", encode([lineage])],
    ["a header over 4096 bytes", encode({ ...lineage, pad: "p".repeat(4096) })],
  ])("ignores %s", (_label, header) => {
    expect(
      feedbackTrace(
        request({
          "external-request-id": "caller-op-7",
          "x-firecrawl-mcp-lineage": header,
        }),
      ),
    ).toEqual({ external_request_id: "caller-op-7", ...noLineage });
  });

  it("reads a header of exactly 4096 bytes", () => {
    // 3072 bytes of JSON encode to exactly 4096 base64url characters.
    const unpadded = JSON.stringify({ ...lineage, pad: "" }).length;
    const header = encode({ ...lineage, pad: "p".repeat(3072 - unpadded) });
    expect(Buffer.byteLength(header)).toBe(4096);
    expect(
      feedbackTrace(request({ "x-firecrawl-mcp-lineage": header })).session_id,
    ).toBe(lineage.session_id);
  });

  it.each([
    ["an id with a space", { session_id: "sess 1" }],
    ["an empty id", { session_id: "" }],
    ["an id over 128 characters", { session_id: "s".repeat(129) }],
    ["an id that is not a string", { session_id: 42 }],
    ["an id that looks like an API key", { session_id: "fc-0123456789abcdef" }],
    ["an unknown source", { session_source: "cookie" }],
    ["a source of the other pair", { session_source: "client" }],
    ["a missing source", { session_source: undefined }],
    ["a missing id", { session_id: undefined }],
  ])("drops the session pair for %s and keeps the rest", (_label, change) => {
    expect(trace({ ...lineage, ...change })).toEqual({
      external_request_id: null,
      ...lineage,
      session_id: null,
      session_source: null,
    });
  });

  it.each([
    ["a bad id", { thread_id: "thread/42" }],
    ["an unknown source", { thread_source: "token" }],
    ["a missing id", { thread_id: undefined }],
  ])("drops the thread pair for %s and keeps the rest", (_label, change) => {
    expect(trace({ ...lineage, ...change })).toEqual({
      external_request_id: null,
      ...lineage,
      thread_id: null,
      thread_source: null,
    });
  });

  it.each(["token", "trace", "sse"])("accepts session source %s", source => {
    expect(trace({ ...lineage, session_source: source }).session_source).toBe(
      source,
    );
  });

  it.each(["argument", "session", "minted", "client"])(
    "accepts thread source %s",
    source => {
      expect(trace({ ...lineage, thread_source: source }).thread_source).toBe(
        source,
      );
    },
  );

  it("trims the objective and cuts it to 1000 characters", () => {
    expect(trace({ objective: "  Compare two plans.  " }).objective).toBe(
      "Compare two plans.",
    );
    expect(trace({ objective: "o".repeat(1000) }).objective).toBe(
      "o".repeat(1000),
    );
    expect(trace({ objective: "o".repeat(1500) }).objective).toBe(
      "o".repeat(1000),
    );
  });

  it.each([
    [
      "a bearer token",
      "Log in with Bearer abc123.def",
      "Log in with [redacted]",
    ],
    [
      "an API key",
      "Scrape it using fc-0123456789abcdef0123 please",
      "Scrape it using [redacted] please",
    ],
    [
      "a JSON web token",
      "Send eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      "Send [redacted]",
    ],
  ])("redacts %s in the objective", (_label, objective, stored) => {
    expect(trace({ objective }).objective).toBe(stored);
  });

  it("accepts a padded base64url header", () => {
    // 19 bytes of JSON, so standard padding adds "==".
    const header = Buffer.from('{"objective":"Go!"}').toString("base64");
    expect(header).toMatch(/^[A-Za-z0-9]+==$/);
    expect(
      feedbackTrace(request({ "x-firecrawl-mcp-lineage": header })).objective,
    ).toBe("Go!");
  });

  it("replaces control characters in the objective, which a text column rejects", () => {
    expect(trace({ objective: "Compare\u0000two\nplans" }).objective).toBe(
      "Compare two plans",
    );
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a number", 7],
    ["an object", { goal: "x" }],
  ])("stores no objective for %s", (_label, objective) => {
    expect(trace({ ...lineage, objective })).toEqual({
      external_request_id: null,
      ...lineage,
      objective: null,
    });
  });
});
