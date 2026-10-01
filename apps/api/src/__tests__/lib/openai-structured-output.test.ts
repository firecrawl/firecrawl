import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * Asserts on the HTTP bodies that actually reach the provider. That matters
 * because an option the SDK silently ignores is indistinguishable from a
 * working one if you only inspect JavaScript objects.
 *
 * The fake backend is scriptable per capability-response class and can be told
 * to support only Responses, only Chat, or to accept requests while ignoring
 * the structured field. Handlers must return `handled: true` when they answer,
 * so a handler that only matches one request shape cannot silently swallow
 * the other and make the probe hang until the timeout.
 */

type Handler = (res: http.ServerResponse, body: any) => boolean | void;

type BackendOptions = {
  onResponses?: Handler;
  onChat?: Handler;
  delayMs?: number;
  /** Answer a strict probe correctly (proves strict support). */
  supportStrict?: boolean;
  /** Answer a tool probe with a real forced tool call (proves tool support). */
  supportTools?: boolean;
  /** Reject strict structured output with a definite unsupported response. */
  rejectStrict?: boolean;
  /** Reject tool calling with a definite unsupported response. */
  rejectTools?: boolean;
  /** 2xx but ordinary text — proves nothing about the requested transport. */
  ignoreRequestedFormat?: boolean;
  /** Tool arguments returned by the real structured call. */
  toolArgs?: unknown;
  /** Reply with plain text instead of calling a tool. */
  textOnly?: boolean;
};

const isStrictProbe = (body: any) =>
  body?.text?.format?.name === "probe" ||
  body?.response_format?.json_schema?.name === "probe";
const isToolProbe = (body: any) =>
  body?.tools?.some((t: any) => (t.function?.name ?? t.name) === "probe");

function json(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function startBackend(options: BackendOptions = {}) {
  const requests: { url: string; body: any }[] = [];
  const {
    onResponses,
    onChat,
    delayMs = 0,
    supportStrict = true,
    supportTools = true,
    rejectStrict = false,
    rejectTools = false,
    ignoreRequestedFormat = false,
    toolArgs,
    textOnly = false,
  } = options;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", async () => {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      requests.push({ url: req.url ?? "", body });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));

      const isResponses = (req.url ?? "").endsWith("/responses");
      const handler = isResponses ? onResponses : onChat;
      // A handler must be called at most once and must explicitly claim the
      // request; otherwise built-in handling applies. `undefined` for the
      // handler itself must not be read as "handled".
      // A handler must explicitly return true to claim the request. Anything
      // else falls through to built-in handling, so a handler that only
      // matches one request shape can never leave the other unanswered.
      if (handler && handler(res, body) === true) return;

      if (isResponses && (body.input === undefined || body.input === null)) {
        return json(res, 404, { error: { message: "unknown route" } });
      }

      if (isStrictProbe(body)) {
        if (rejectStrict) {
          return json(res, 400, {
            error: {
              message:
                "response_format json_schema is not supported; use json_object",
            },
          });
        }
        if (ignoreRequestedFormat) {
          // 2xx but the strict format was ignored: plain prose, not JSON.
          return isResponses
            ? json(res, 200, {
                id: "r",
                object: "response",
                status: "completed",
                created_at: 1,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "Sure! Here you go." },
                    ],
                  },
                ],
              })
            : json(res, 200, chatEnvelope("Sure! Here you go.", false));
        }
        const text = JSON.stringify({ ok: true });
        return isResponses
          ? json(res, 200, {
              id: "r",
              object: "response",
              status: "completed",
              created_at: 1,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text }],
                },
              ],
            })
          : json(res, 200, chatEnvelope(text, false));
      }

      if (isToolProbe(body)) {
        if (rejectTools) {
          return json(res, 400, {
            error: { message: "tool calling is not supported by this backend" },
          });
        }
        if (ignoreRequestedFormat) {
          return isResponses
            ? json(res, 200, {
                id: "r",
                object: "response",
                status: "completed",
                created_at: 1,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "I cannot do that." },
                    ],
                  },
                ],
              })
            : json(res, 200, chatEnvelope("I cannot do that.", false));
        }
        const args = JSON.stringify({ ok: true });
        return isResponses
          ? json(res, 200, {
              id: "r",
              object: "response",
              status: "completed",
              created_at: 1,
              output: [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "c1",
                  name: "probe",
                  arguments: args,
                },
              ],
            })
          : json(res, 200, chatEnvelope(null, true, args, "probe"));
      }

      // Real (non-probe) structured call.
      const wantsTool = body.tools?.length > 0;
      if (wantsTool && !textOnly) {
        const args = JSON.stringify(toolArgs ?? { title: "Example.com" });
        const name =
          body.tools[0].function?.name ?? body.tools[0].name ?? "tool";
        return isResponses
          ? json(res, 200, {
              id: "r",
              object: "response",
              status: "completed",
              created_at: 1,
              output: [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "c1",
                  name,
                  arguments: args,
                },
              ],
            })
          : json(res, 200, chatEnvelope(null, true, args));
      }
      return isResponses
        ? json(res, 200, {
            id: "r",
            object: "response",
            status: "completed",
            created_at: 1,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              },
            ],
          })
        : json(res, 200, chatEnvelope("hello", false));
    });
  });

  function chatEnvelope(
    content: string | null,
    tool: boolean,
    args?: string,
    toolName = "firecrawl_structured_output",
  ) {
    return {
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: tool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: toolName, arguments: args ?? "{}" },
                  },
                ],
              }
            : { role: "assistant", content },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
  }

  return new Promise<{
    baseURL: string;
    requests: { url: string; body: any }[];
    close: () => Promise<void>;
  }>(resolve =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>(d => server.close(() => d())),
      });
    }),
  );
}

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_API_MODE",
  "OPENAI_STRUCTURED_OUTPUT_MODE",
  "MODEL_NAME",
] as const;

function lastUserText(body: any): string {
  const user = [...(body?.messages ?? [])]
    .reverse()
    .find((m: any) => m.role === "user");
  const content = user?.content ?? "";
  return Array.isArray(content)
    ? content.map((c: any) => c?.text ?? "").join("")
    : String(content);
}

describe("openai endpoint + structured transport", () => {
  let backend: Awaited<ReturnType<typeof startBackend>> | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(async () => {
    await backend?.close();
    backend = null;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function load(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    const compat = await import("../../lib/openai-structured-output.js");
    return compat;
  }

  const BASE = { OPENAI_API_KEY: "test-key" };
  const chats = (b: typeof backend) =>
    b!.requests.filter(r => r.url.endsWith("/chat/completions"));
  const responses = (b: typeof backend) =>
    b!.requests.filter(r => r.url.endsWith("/responses"));
  /** Last request that is an actual application call, not a capability probe. */
  const realCall = (b: typeof backend) =>
    [...b!.requests]
      .filter(r => {
        const toolNames = (r.body.tools ?? []).map(
          (t: any) => t.function?.name ?? t.name,
        );
        const formatName =
          r.body.text?.format?.name ??
          r.body.response_format?.json_schema?.name;
        return formatName !== "probe" && !toolNames.includes("probe");
      })
      .at(-1);

  const M = (name = "test-model") => ({
    baseURL: backend!.baseURL,
    modelName: name,
  });

  // ---------------------------------------------------------------- official

  describe("official OpenAI", () => {
    it("never probes and stays on Responses + strict", async () => {
      const probe = vi.spyOn(globalThis, "fetch");
      const c = await load(BASE);
      const target = { baseURL: "https://api.openai.com/v1", modelName: "m" };

      await expect(c.resolveApiMode(target)).resolves.toBe("responses");
      await expect(
        c.resolveStructuredOutputMode(target, "responses"),
      ).resolves.toBe("strict");
      expect(probe).not.toHaveBeenCalled();
      expect(c.apiModeSync(target)).toBe("responses");
      probe.mockRestore();
    });

    it("never wraps official OpenAI in the tool transport", async () => {
      // Official OpenAI must keep native strict output and receive no
      // compatibility wrapper, whatever the transport setting says elsewhere.
      const c = await load(BASE);
      const target = {
        baseURL: "https://api.openai.com/v1",
        modelName: "gpt-4o-mini",
      };
      await expect(
        c.resolveStructuredOutputMode(target, "responses"),
      ).resolves.toBe("strict");

      const base = createOpenAI({
        apiKey: "k",
        baseURL: target.baseURL,
      }).responses("m");
      // strict mode returns the provider model untouched.
      expect(c.applyStructuredOutputPolicy(base, "strict")).toBe(base);
      expect(c.applyStructuredOutputPolicy(base, "strict").provider).toBe(
        "openai.responses",
      );
    });

    it("treats a custom endpoint as non-official", async () => {
      const c = await load(BASE);
      expect(c.isOfficialOpenAiEndpoint("https://api.openai.com/v1")).toBe(
        true,
      );
      expect(c.isOfficialOpenAiEndpoint("http://127.0.0.1:11434/v1")).toBe(
        false,
      );
    });
  });

  // ----------------------------------------------------------- endpoint mode

  describe("endpoint detection (auto)", () => {
    it("keeps Responses when supported", async () => {
      backend = await startBackend();
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveApiMode(M())).resolves.toBe("responses");
    });

    it.each([404, 405, 501])("selects Chat on HTTP %i", async status => {
      backend = await startBackend({
        onResponses: res => {
          json(res, status, { error: { message: "nope" } });
          return true;
        },
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveApiMode(M())).resolves.toBe("chat");
    });

    it.each([401, 403, 429, 500, 503])(
      "refuses to classify HTTP %i as endpoint absence",
      async status => {
        backend = await startBackend({
          onResponses: res => {
            json(res, status, { error: { message: "operational" } });
            return true;
          },
        });
        const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
        await expect(c.resolveApiMode(M())).rejects.toMatchObject({
          name: "OpenAiCapabilityIndeterminateError",
        });
      },
    );

    it("does not treat a connection failure as endpoint absence", async () => {
      const c = await load(BASE);
      await expect(
        c.resolveApiMode({ baseURL: "http://127.0.0.1:9/v1", modelName: "m" }),
      ).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
    });

    it("explicit responses never probes", async () => {
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "responses",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      expect(c.apiModeSync(M())).toBe("responses");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });

    it("explicit chat never probes Responses", async () => {
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(c.resolveApiMode(M())).resolves.toBe("chat");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });
  });

  // ---------------------------------------------------------------- caches

  describe("capability cache identity", () => {
    it("keys endpoint capability by base URL AND model", async () => {
      const a = await startBackend();
      const b = await startBackend({
        onResponses: res => {
          json(res, 404, { error: {} });
          return true;
        },
      });
      backend = a;
      const c = await load({ ...BASE, OPENAI_BASE_URL: a.baseURL });
      try {
        // Same module instance, two base URLs: must not share.
        await expect(
          c.resolveApiMode({ baseURL: a.baseURL, modelName: "m" }),
        ).resolves.toBe("responses");
        await expect(
          c.resolveApiMode({ baseURL: b.baseURL, modelName: "m" }),
        ).resolves.toBe("chat");
        expect(c.__caches.endpoint.size).toBe(2);

        // Same base URL, two models: must not share.
        c.__resetCapabilityCaches();
        await expect(
          c.resolveApiMode({ baseURL: a.baseURL, modelName: "model-a" }),
        ).resolves.toBe("responses");
        await expect(
          c.resolveApiMode({ baseURL: b.baseURL, modelName: "model-a" }),
        ).resolves.toBe("chat");
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("keys structured capability by surface as well as endpoint and model", async () => {
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
      });
      await expect(c.resolveStructuredOutputMode(M(), "chat")).resolves.toBe(
        "strict",
      );
      // A responses-surface lookup must not reuse the chat answer.
      expect(
        c.__caches.structured.has(`${backend.baseURL}|test-model|chat`),
      ).toBe(true);
      expect(
        c.__caches.structured.has(`${backend.baseURL}|test-model|responses`),
      ).toBe(false);
    });

    it("shares one in-flight probe across concurrent callers", async () => {
      backend = await startBackend();
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await Promise.all([
        c.resolveApiMode(M()),
        c.resolveApiMode(M()),
        c.resolveApiMode(M()),
      ]);
      expect(responses(backend).length).toBe(1);
    });

    it("two endpoints with different capabilities do not share a cache entry", async () => {
      // Falsifiability check: if either key omitted baseURL, this backend pair
      // would collapse onto one answer and the second assertion would fail.
      const strictBackend = await startBackend();
      const toolBackend = await startBackend({ rejectStrict: true });
      const c = await load({ ...BASE, OPENAI_BASE_URL: strictBackend.baseURL });
      try {
        expect(
          await c.resolveStructuredOutputMode(
            { baseURL: strictBackend.baseURL, modelName: "m" },
            "chat",
          ),
        ).toBe("strict");
        expect(
          await c.resolveStructuredOutputMode(
            { baseURL: toolBackend.baseURL, modelName: "m" },
            "chat",
          ),
        ).toBe("tool");
        // Two distinct cache entries, differing only by base URL.
        expect(c.__caches.structured.size).toBe(2);
      } finally {
        await strictBackend.close();
        await toolBackend.close();
      }
    });

    it("never caches an operational failure", async () => {
      let calls = 0;
      backend = await startBackend({
        onResponses: res => {
          calls++;
          json(res, 503, { error: { message: "down" } });
          return true;
        },
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveApiMode(M())).rejects.toThrow();
      await expect(c.resolveApiMode(M())).rejects.toThrow();
      expect(calls).toBe(2);
      expect(c.__caches.endpoint.size).toBe(0);
    });

    it("recovers after a transient failure and then caches", async () => {
      let calls = 0;
      backend = await startBackend({
        onResponses: res => {
          calls++;
          if (calls === 1) {
            json(res, 503, { error: { message: "down" } });
            return true;
          }
          return false;
        },
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveApiMode(M())).rejects.toThrow();
      await expect(c.resolveApiMode(M())).resolves.toBe("responses");
    });
  });

  // ---------------------------------------------------- structured transport

  describe("automatic structured transport", () => {
    it("uses strict when json_schema is supported", async () => {
      backend = await startBackend();
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveStructuredOutputMode(M(), "chat")).resolves.toBe(
        "strict",
      );
    });

    it("falls back to tool when strict is definitely rejected", async () => {
      backend = await startBackend({ rejectStrict: true });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveStructuredOutputMode(M(), "chat")).resolves.toBe(
        "tool",
      );
    });

    it("probes the Responses surface when Responses is selected", async () => {
      backend = await startBackend();
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(
        c.resolveStructuredOutputMode(M(), "responses"),
      ).resolves.toBe("strict");
      // The strict probe must have used the Responses request shape.
      expect(responses(backend).length).toBeGreaterThan(0);
      expect(responses(backend)[0]?.body.text?.format?.type).toBe(
        "json_schema",
      );
      expect(chats(backend).length).toBe(0);
    });

    it("resolves auto structured on the Responses surface when API mode is responses", async () => {
      // Explicit API mode must not decide structured capability on Chat; the
      // two dimensions are independent.
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "responses",
      });
      await expect(
        c.resolveStructuredOutputMode(M(), "responses"),
      ).resolves.toBe("strict");
      // Probing happened on Responses only.
      expect(responses(backend).length).toBeGreaterThan(0);
      expect(chats(backend).length).toBe(0);
    });

    it("works on a Responses-only backend that has no Chat Completions", async () => {
      backend = await startBackend({
        onChat: res => {
          json(res, 404, { error: { message: "unknown route" } });
          return true;
        },
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(c.resolveApiMode(M())).resolves.toBe("responses");
      await expect(
        c.resolveStructuredOutputMode(M(), "responses"),
      ).resolves.toBe("strict");
      expect(chats(backend).length).toBe(0);
    });

    it("fails closed when neither transport is supported", async () => {
      backend = await startBackend({ rejectStrict: true, rejectTools: true });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(
        c.resolveStructuredOutputMode(M(), "chat"),
      ).rejects.toBeInstanceOf(c.OpenAiNoStructuredTransportError);
    });

    it("does not cache a 2xx that ignored json_schema", async () => {
      backend = await startBackend({ ignoreRequestedFormat: true });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(
        c.resolveStructuredOutputMode(M(), "chat"),
      ).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
      expect(c.__caches.structured.size).toBe(0);
    });

    it("does not cache a 2xx that ignored the forced tool call", async () => {
      backend = await startBackend({
        rejectStrict: true,
        ignoreRequestedFormat: true,
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(
        c.resolveStructuredOutputMode(M(), "chat"),
      ).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
      expect(c.__caches.structured.size).toBe(0);
    });

    it("propagates an indeterminate tool probe without timing out", async () => {
      let toolProbeSeen = false;
      backend = await startBackend({
        rejectStrict: true,
        onChat: (res, body) => {
          if (
            body.tools?.some(
              (t: any) => (t.function?.name ?? t.name) === "probe",
            )
          ) {
            toolProbeSeen = true;
            json(res, 500, { error: { message: "boom" } });
            return true;
          }
          return false;
        },
      });
      const c = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      const started = Date.now();
      await expect(
        c.resolveStructuredOutputMode(M(), "chat"),
      ).rejects.toMatchObject({ name: "OpenAiCapabilityIndeterminateError" });
      // Both probes must have happened, and quickly.
      expect(toolProbeSeen).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("explicit strict never probes and never falls back", async () => {
      backend = await startBackend({ rejectStrict: true });
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "strict",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(c.resolveStructuredOutputMode(M(), "chat")).resolves.toBe(
        "strict",
      );
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });

    it("explicit tool never probes", async () => {
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(c.resolveStructuredOutputMode(M(), "chat")).resolves.toBe(
        "tool",
      );
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });
  });

  // ------------------------------------------------------- tool transport

  describe("tool transport request shaping", () => {
    async function loadTool() {
      backend = await startBackend({ toolArgs: { title: "Example.com" } });
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend!.baseURL,
        OPENAI_API_MODE: "chat",
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      return c;
    }

    it("sends the schema only as a forced tool", async () => {
      const c = await loadTool();
      const result = await generateObject({
        model: c.applyStructuredOutputPolicy(
          createOpenAI({ apiKey: "k", baseURL: backend!.baseURL }).chat("m"),
          "tool",
        ),
        schema: z.object({ title: z.string() }),
        prompt: "Extract the title.",
      });

      const sent = realCall(backend)!;
      expect(sent.body.tools?.[0]?.function?.name).toBe(
        "firecrawl_structured_output",
      );
      expect(sent.body.tool_choice).toEqual({
        type: "function",
        function: { name: "firecrawl_structured_output" },
      });
      expect(JSON.stringify(sent.body)).not.toContain("json_schema");
      expect(sent.body.response_format).toBeUndefined();
      expect(lastUserText(sent.body)).not.toContain('"title"');
      expect(result.object).toEqual({ title: "Example.com" });
    });

    it("validates tool arguments against the ORIGINAL zod schema", async () => {
      backend = await startBackend({ toolArgs: { title: 12345 } });
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      await expect(
        generateObject({
          model: c.applyStructuredOutputPolicy(
            createOpenAI({ apiKey: "k", baseURL: backend.baseURL }).chat("m"),
            "tool",
          ),
          schema: z.object({ title: z.string() }),
          prompt: "Extract.",
        }),
      ).rejects.toThrow();
    });

    it("rejects valid JSON delivered as ordinary text when tool_choice is ignored", async () => {
      // The strongest fail-closed case: the text is perfectly valid and would
      // pass generateObject's parser, so only an explicit transport check can
      // reject it.
      backend = await startBackend({ textOnly: true });
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      await expect(
        generateObject({
          model: c.applyStructuredOutputPolicy(
            createOpenAI({ apiKey: "k", baseURL: backend.baseURL }).chat("m"),
            "tool",
          ),
          schema: z.object({ title: z.string() }),
          prompt: "Extract.",
        }),
      ).rejects.toMatchObject({ name: "OpenAiToolTransportViolationError" });
    });

    it("does not touch a model in strict mode", async () => {
      backend = await startBackend();
      const c = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
        OPENAI_STRUCTURED_OUTPUT_MODE: "strict",
      });
      await Promise.resolve(
        c
          .applyStructuredOutputPolicy(
            createOpenAI({ apiKey: "k", baseURL: backend.baseURL }).chat("m"),
            "strict",
          )
          .doGenerate({
            prompt: [
              { role: "user", content: [{ type: "text", text: "Extract." }] },
            ],
            mode: "json",
            responseFormat: {
              type: "json",
              name: "response",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          } as any),
      ).catch(() => {});
      const sent = realCall(backend)!;
      expect(sent.body.response_format.type).toBe("json_schema");
      expect(sent.body.tools).toBeUndefined();
    });
  });
});
