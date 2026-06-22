import http from "http";
import { AddressInfo } from "net";
import { config } from "../config";
import { redactText } from "./fire-privacy-client";

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

let server: http.Server;
let baseUrl: string;
let originalUrl: string | undefined;
let handler: Handler = (_req, res) => {
  res.statusCode = 500;
  res.end();
};

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      void Promise.resolve(handler(req, res)).catch(err => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      originalUrl = config.FIRE_PRIVACY_URL;
      config.FIRE_PRIVACY_URL = baseUrl;
      resolve();
    });
  });
});

afterAll(async () => {
  config.FIRE_PRIVACY_URL = originalUrl;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end();
  };
});

function withBody(body: unknown, status = 200): Handler {
  return (_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

describe("redactText", () => {
  it("returns status=ok with redacted_text and spans on 200", async () => {
    handler = withBody({
      redacted_text: "Hi, my name is <PERSON>.",
      spans: [
        {
          start: 15,
          end: 26,
          kind: "PERSON",
          score: 0.9,
          source: "SpacyRecognizer",
        },
      ],
      model_status: "ok",
    });

    const out = await redactText({ text: "Hi, my name is Alice Smith." });

    expect(out.status).toBe("ok");
    expect(out.reason).toBeUndefined();
    expect(out.redactedMarkdown).toBe("Hi, my name is <PERSON>.");
    expect(out.spans).toHaveLength(1);
    expect(out.spans[0]).toMatchObject({
      kind: "PERSON",
      entity: "PERSON",
      source: "heuristics",
      score: 0.9,
    });
    expect(out.counts).toEqual({ PERSON: 1 });
  });

  it("treats absent model_status as ok", async () => {
    handler = withBody({
      redacted_text: "redacted",
      spans: [],
    });

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("ok");
    expect(out.redactedMarkdown).toBe("redacted");
    expect(out.counts).toEqual({});
  });

  it("returns status=skipped with reason=upstream_skipped when model_status is skipped", async () => {
    handler = withBody({
      redacted_text: "",
      spans: [],
      model_status: "skipped",
    });

    const out = await redactText({ text: "input-not-empty" });
    expect(out.status).toBe("skipped");
    expect(out.reason).toBe("upstream_skipped");
    expect(out.redactedMarkdown).toBe("");
  });

  it("short-circuits empty input to skipped with empty_input and no HTTP call", async () => {
    let called = false;
    handler = (_req, res) => {
      called = true;
      res.statusCode = 500;
      res.end();
    };

    const out = await redactText({ text: "   \n\t" });
    expect(called).toBe(false);
    expect(out.status).toBe("skipped");
    expect(out.reason).toBe("empty_input");
    expect(out.redactedMarkdown).toBe("   \n\t");
    expect(out.spans).toEqual([]);
    expect(out.counts).toEqual({});
  });

  it("maps 503 to failed/service_unavailable, null markdown", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("service_unavailable");
    expect(out.redactedMarkdown).toBeNull();
    expect(out.spans).toEqual([]);
    expect(out.counts).toEqual({});
  });

  it("maps 413 (input too large) to failed/error", async () => {
    handler = (_req, res) => {
      res.statusCode = 413;
      res.end();
    };

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("error");
    expect(out.redactedMarkdown).toBeNull();
  });

  it("maps generic 5xx to failed/error", async () => {
    handler = (_req, res) => {
      res.statusCode = 502;
      res.end();
    };

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("error");
    expect(out.redactedMarkdown).toBeNull();
  });

  it("returns failed/error when model_status is error", async () => {
    handler = withBody({
      redacted_text: "anything",
      spans: [],
      model_status: "error",
    });

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("error");
    expect(out.redactedMarkdown).toBeNull();
  });

  it("returns failed/timeout when fire-privacy exceeds the budget", async () => {
    handler = (_req, res) => {
      // Hang past the timeout.
      setTimeout(() => {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            redacted_text: "late",
            spans: [],
            model_status: "ok",
          }),
        );
      }, 200);
    };

    const out = await redactText({ text: "input", timeoutMs: 50 });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("timeout");
    expect(out.redactedMarkdown).toBeNull();
  });

  it("returns failed/error when the URL is unreachable", async () => {
    const originalLocalUrl = config.FIRE_PRIVACY_URL;
    config.FIRE_PRIVACY_URL = "http://127.0.0.1:1";
    try {
      const out = await redactText({ text: "input", timeoutMs: 500 });
      expect(out.status).toBe("failed");
      expect(out.reason).toBe("error");
      expect(out.redactedMarkdown).toBeNull();
    } finally {
      config.FIRE_PRIVACY_URL = originalLocalUrl;
    }
  });

  it("returns failed/error without an HTTP call when FIRE_PRIVACY_URL is unset", async () => {
    let called = false;
    handler = (_req, res) => {
      called = true;
      res.statusCode = 200;
      res.end();
    };
    const originalLocalUrl = config.FIRE_PRIVACY_URL;
    config.FIRE_PRIVACY_URL = undefined;
    try {
      const out = await redactText({ text: "input" });
      expect(called).toBe(false);
      expect(out.status).toBe("failed");
      expect(out.reason).toBe("error");
      expect(out.redactedMarkdown).toBeNull();
    } finally {
      config.FIRE_PRIVACY_URL = originalLocalUrl;
    }
  });

  it("returns failed/error on invalid JSON response", async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{not json");
    };

    const out = await redactText({ text: "input" });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("error");
    expect(out.redactedMarkdown).toBeNull();
  });

  it("filters malformed spans", async () => {
    handler = withBody({
      redacted_text: "redacted",
      spans: [
        { start: 0, end: 5, kind: "PERSON", score: 0.9, source: "x" },
        { start: "bad", end: 5, kind: "PERSON" },
        null,
        { start: 10, end: 15, kind: "EMAIL_ADDRESS" },
      ],
    });

    const out = await redactText({ text: "input" });
    expect(out.spans).toHaveLength(2);
    expect(out.spans[0].kind).toBe("PERSON");
    expect(out.spans[1].kind).toBe("EMAIL_ADDRESS");
    // No `score` field when fire-privacy didn't supply one.
    expect(out.spans[1].score).toBeUndefined();
    // Opaque source falls back to "unknown".
    expect(out.spans[1].source).toBe("unknown");
    // Counts roll up by entity, not kind.
    expect(out.counts).toEqual({ PERSON: 1, EMAIL: 1 });
  });

  it("attaches public entity bucket to each span; omits when unmapped", async () => {
    handler = withBody({
      redacted_text: "x",
      spans: [
        {
          start: 0,
          end: 5,
          kind: "PRIVATE_PERSON",
          source: "openai-privacy-filter",
        },
        { start: 6, end: 10, kind: "EMAIL_ADDRESS", source: "EmailRecognizer" },
        { start: 11, end: 15, kind: "ORGANIZATION", source: "SpacyRecognizer" },
      ],
    });
    const out = await redactText({ text: "input here.." });
    expect(out.spans[0]).toMatchObject({
      kind: "PRIVATE_PERSON",
      entity: "PERSON",
      source: "model",
    });
    expect(out.spans[1]).toMatchObject({
      kind: "EMAIL_ADDRESS",
      entity: "EMAIL",
      source: "heuristics",
    });
    expect(out.spans[2].kind).toBe("ORGANIZATION");
    expect(out.spans[2].entity).toBeUndefined();
    // Unmapped spans don't roll into counts.
    expect(out.counts).toEqual({ PERSON: 1, EMAIL: 1 });
  });

  it("sends mode/operator/language defaults", async () => {
    let captured: Record<string, unknown> | undefined;
    handler = async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      captured = JSON.parse(Buffer.concat(chunks).toString());
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ redacted_text: "ok", spans: [], model_status: "ok" }),
      );
    };

    await redactText({ text: "input" });
    expect(captured).toMatchObject({
      text: "input",
      mode: "model",
      operator: "replace",
      language: "en",
    });
  });

  // ---- mode + replaceStyle mapping ----------------------------------------

  it("maps each public mode to the fire-privacy internal mode", async () => {
    const cases: Array<
      ["accurate" | "aggressive" | "fast", "model" | "both" | "heuristics"]
    > = [
      ["accurate", "model"],
      ["aggressive", "both"],
      ["fast", "heuristics"],
    ];
    for (const [external, internalMode] of cases) {
      let captured: Record<string, unknown> | undefined;
      handler = async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        captured = JSON.parse(Buffer.concat(chunks).toString());
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            redacted_text: "x",
            spans: [],
            model_status: "ok",
          }),
        );
      };
      await redactText({
        text: "x",
        options: { mode: external, replaceStyle: "tag" },
      });
      expect(captured?.mode).toBe(internalMode);
    }
  });

  it("maps each replaceStyle to the fire-privacy operator", async () => {
    const cases: Array<
      ["tag" | "mask" | "remove", "replace" | "mask" | "redact"]
    > = [
      ["tag", "replace"],
      ["mask", "mask"],
      ["remove", "redact"],
    ];
    for (const [external, operator] of cases) {
      let captured: Record<string, unknown> | undefined;
      handler = async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        captured = JSON.parse(Buffer.concat(chunks).toString());
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            redacted_text: "x",
            spans: [],
            model_status: "ok",
          }),
        );
      };
      await redactText({
        text: "x",
        options: { mode: "accurate", replaceStyle: external },
      });
      expect(captured?.operator).toBe(operator);
    }
  });

  // ---- entities filter ----------------------------------------------------

  it("filters spans to the requested entities and re-renders markdown", async () => {
    handler = withBody({
      redacted_text:
        "Hi, my name is <PRIVATE_PERSON>. Email me at <EMAIL_ADDRESS>.",
      spans: [
        {
          start: 15,
          end: 26,
          kind: "PRIVATE_PERSON",
          score: 1.0,
          source: "openai-privacy-filter",
        },
        {
          start: 40,
          end: 57,
          kind: "EMAIL_ADDRESS",
          score: 1.0,
          source: "EmailRecognizer",
        },
      ],
      model_status: "ok",
    });

    const source = "Hi, my name is Alice Smith. Email me at alice@example.com.";
    const out = await redactText({
      text: source,
      options: {
        mode: "accurate",
        replaceStyle: "tag",
        entities: ["EMAIL"],
      },
    });

    expect(out.status).toBe("ok");
    // Person span filtered out; email retained.
    expect(out.spans).toHaveLength(1);
    expect(out.spans[0].kind).toBe("EMAIL_ADDRESS");
    expect(out.spans[0].entity).toBe("EMAIL");
    // Markdown re-rendered from the filtered span set: name stays, email
    // gets replaced with the kind tag.
    expect(out.redactedMarkdown).toBe(
      "Hi, my name is Alice Smith. Email me at <EMAIL_ADDRESS>.",
    );
    expect(out.counts).toEqual({ EMAIL: 1 });
  });

  it("uses upstream redacted_text when no entity filter is set", async () => {
    handler = withBody({
      redacted_text: "<PRIVATE_PERSON>",
      spans: [
        {
          start: 0,
          end: 11,
          kind: "PRIVATE_PERSON",
          score: 1.0,
          source: "openai-privacy-filter",
        },
      ],
      model_status: "ok",
    });

    const out = await redactText({
      text: "Alice Smith",
      options: { mode: "accurate", replaceStyle: "tag" },
    });

    expect(out.redactedMarkdown).toBe("<PRIVATE_PERSON>");
  });

  it("drops spans whose kind doesn't map to any allowed entity", async () => {
    handler = withBody({
      redacted_text: "x",
      spans: [
        // Kind isn't in the unified taxonomy → drops under any allowlist.
        { start: 0, end: 5, kind: "ORGANIZATION", score: 1.0, source: "x" },
      ],
      model_status: "ok",
    });

    const out = await redactText({
      text: "ABCDE end",
      options: {
        mode: "accurate",
        replaceStyle: "tag",
        entities: ["PERSON", "EMAIL"],
      },
    });

    expect(out.spans).toEqual([]);
    expect(out.redactedMarkdown).toBe("ABCDE end");
    expect(out.counts).toEqual({});
  });

  it("re-renders with mask style preserving span length", async () => {
    // Source: "Alice Smith - email alice@example.com" (37 chars)
    // Person spans 0..11, email spans 20..37.
    handler = withBody({
      redacted_text: "***********",
      spans: [
        {
          start: 0,
          end: 11,
          kind: "PRIVATE_PERSON",
          score: 1.0,
          source: "openai-privacy-filter",
        },
        {
          start: 20,
          end: 37,
          kind: "EMAIL_ADDRESS",
          score: 1.0,
          source: "EmailRecognizer",
        },
      ],
      model_status: "ok",
    });

    const source = "Alice Smith - email alice@example.com";
    const out = await redactText({
      text: source,
      options: {
        mode: "accurate",
        replaceStyle: "mask",
        entities: ["EMAIL"], // filter triggers re-render
      },
    });

    expect(out.redactedMarkdown).toBe("Alice Smith - email *****************");
  });

  // ---- chunked path (input over single-chunk threshold) ------------------

  it("chunks long input and merges spans with corrected offsets", async () => {
    // Build a >28K-char input by repeating a paragraph with a marker name
    // every block. Each chunk handler returns spans local to its own text;
    // the client should lift them into source coordinates.
    const para =
      "Lorem ipsum dolor sit amet. Please contact Alice Carter today.\n\n";
    const text = para.repeat(700); // ~44K chars → multiple chunks
    expect(text.length).toBeGreaterThan(28_000);

    // Per-chunk handler: scan the received text for "Alice Carter" and
    // return spans local to that chunk. The handler echos a redacted_text
    // built from the chunk's input with names replaced.
    handler = async (req, res) => {
      const buf: Buffer[] = [];
      for await (const c of req) buf.push(c as Buffer);
      const { text: chunkText } = JSON.parse(Buffer.concat(buf).toString());
      const localSpans: Array<{
        start: number;
        end: number;
        kind: string;
        score: number;
        source: string;
      }> = [];
      let idx = 0;
      const needle = "Alice Carter";
      while ((idx = chunkText.indexOf(needle, idx)) !== -1) {
        localSpans.push({
          start: idx,
          end: idx + needle.length,
          kind: "PERSON",
          score: 0.95,
          source: "test",
        });
        idx += needle.length;
      }
      const redacted = chunkText.replaceAll(needle, "<PERSON>");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          redacted_text: redacted,
          spans: localSpans,
          model_status: "ok",
        }),
      );
    };

    const out = await redactText({ text });
    expect(out.status).toBe("ok");
    // Every occurrence of "Alice Carter" in the source text should appear
    // as a span with source-coordinate offsets that match.
    const expectedHits: number[] = [];
    let i = 0;
    while ((i = text.indexOf("Alice Carter", i)) !== -1) {
      expectedHits.push(i);
      i += "Alice Carter".length;
    }
    expect(out.spans.length).toBe(expectedHits.length);
    for (let k = 0; k < expectedHits.length; k++) {
      expect(out.spans[k].start).toBe(expectedHits[k]);
      expect(out.spans[k].end).toBe(expectedHits[k] + "Alice Carter".length);
      // Source-coordinate offsets must point at "Alice Carter" in the source.
      expect(text.slice(out.spans[k].start, out.spans[k].end)).toBe(
        "Alice Carter",
      );
    }
    expect(out.counts.PERSON).toBe(expectedHits.length);
  });

  it("returns skipped/too_large above the byte ceiling without an HTTP call", async () => {
    let called = false;
    handler = (_req, res) => {
      called = true;
      res.statusCode = 500;
      res.end();
    };

    // 260KB → above the 250KB ceiling.
    const text = "x".repeat(260_000);
    const out = await redactText({ text });

    expect(called).toBe(false);
    expect(out.status).toBe("skipped");
    expect(out.reason).toBe("too_large");
    expect(out.redactedMarkdown).toBeNull();
    expect(out.spans).toEqual([]);
    expect(out.counts).toEqual({});
  });

  it("fails the whole response when any chunk errors (all-or-nothing)", async () => {
    // Force a long input that will produce multiple chunks. First chunk
    // returns 200; second chunk returns 503. The merged result must be
    // failed/service_unavailable with no partial spans surfaced.
    const text = "Filler. ".repeat(8000); // ~64K chars
    expect(text.length).toBeGreaterThan(28_000);

    let chunkIndex = 0;
    handler = (_req, res) => {
      const current = chunkIndex++;
      if (current === 0) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            redacted_text: "x",
            spans: [
              { start: 0, end: 5, kind: "PERSON", score: 0.9, source: "t" },
            ],
            model_status: "ok",
          }),
        );
      } else {
        res.statusCode = 503;
        res.end();
      }
    };

    const out = await redactText({ text });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("service_unavailable");
    expect(out.redactedMarkdown).toBeNull();
    expect(out.spans).toEqual([]);
    expect(out.counts).toEqual({});
  });

  it("fans out chunked calls (concurrency > 1)", async () => {
    // 3 chunks. Hold each handler open until all 3 are in flight to
    // prove the client doesn't serialize them.
    const text = "Sentence. ".repeat(7000); // ~70K chars → ≥3 chunks
    let inFlight = 0;
    let maxInFlight = 0;
    const gate: Array<() => void> = [];
    const allInFlight = new Promise<void>(resolve => {
      gate.push(resolve);
    });

    handler = async (_req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight >= 2) gate[0]?.();
      // Wait until at least 2 requests have arrived (proves parallelism)
      await Promise.race([
        allInFlight,
        new Promise<void>(r => setTimeout(r, 200)),
      ]);
      inFlight--;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          redacted_text: "x",
          spans: [],
          model_status: "ok",
        }),
      );
    };

    const out = await redactText({ text });
    expect(out.status).toBe("ok");
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("re-renders with remove style dropping span characters", async () => {
    handler = withBody({
      redacted_text: "",
      spans: [
        {
          start: 0,
          end: 11,
          kind: "PRIVATE_PERSON",
          score: 1.0,
          source: "openai-privacy-filter",
        },
        {
          start: 20,
          end: 37,
          kind: "EMAIL_ADDRESS",
          score: 1.0,
          source: "EmailRecognizer",
        },
      ],
      model_status: "ok",
    });

    const source = "Alice Smith - email alice@example.com";
    const out = await redactText({
      text: source,
      options: {
        mode: "accurate",
        replaceStyle: "remove",
        entities: ["PERSON"],
      },
    });

    expect(out.redactedMarkdown).toBe(" - email alice@example.com");
  });
});
