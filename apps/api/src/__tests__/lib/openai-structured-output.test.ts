import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, jsonSchema } from "ai";
import { z } from "zod";

/**
 * Asserts on the HTTP bodies that actually reach the provider. That matters
 * because the whole point of this change is that an option the SDK silently
 * ignores is indistinguishable from a working one if you only inspect
 * JavaScript objects.
 *
 * The fake backend is scriptable per capability-response class so 404 / 405 /
 * 501 / 401 / 403 / 429 / 5xx / timeout can each be exercised, and it can be
 * told to reject json_schema or tools so the auto policy can be walked through
 * every branch.
 */

type Handler = (res: http.ServerResponse, body: any, url: string) => void;

type BackendOptions = {
  onResponses?: Handler;
  onChat?: Handler;
  delayMs?: number;
  chatReply?: string;
  /** Chat reply as a forced tool call, with these arguments. */
  toolArgs?: unknown;
  rejectJsonSchema?: boolean;
  rejectTools?: boolean;
};

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
    chatReply,
    toolArgs,
    rejectJsonSchema = false,
    rejectTools = false,
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
      if (handler) return handler(res, body, req.url ?? "");

      if (isResponses) return json(res, 200, { ok: true });

      const isProbe =
        body.response_format?.json_schema?.name === "probe" ||
        body.tools?.[0]?.function?.name === "probe";
      if (isProbe && body.response_format?.type === "json_schema") {
        return rejectJsonSchema
          ? json(res, 400, {
              error: {
                message: "response_format json_schema is not supported",
              },
            })
          : json(res, 200, { ok: true });
      }
      if (isProbe && body.tools) {
        return rejectTools
          ? json(res, 400, {
              error: {
                message: "tool calling is not supported by this backend",
              },
            })
          : json(res, 200, { ok: true });
      }

      // chatReply forces a plain-text reply, ignoring any tool request.
      const wantTool = body.tools?.length > 0 && chatReply === undefined;
      json(res, 200, {
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          wantTool
            ? {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: body.tools[0].function.name,
                        arguments: JSON.stringify(
                          toolArgs ??
                            (isProbe ? { ok: true } : { title: "Example.com" }),
                        ),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              }
            : {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    chatReply ?? JSON.stringify(isProbe ? { ok: true } : {}),
                },
                finish_reason: "stop",
              },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
    });
  });

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

const SCHEMA = {
  type: "object" as const,
  properties: { title: { type: "string" as const, description: "The title" } },
  required: ["title"],
};

function lastUserText(body: any): string {
  const messages = body?.messages ?? [];
  const user = [...messages].reverse().find((m: any) => m.role === "user");
  const content = user?.content ?? "";
  return Array.isArray(content)
    ? content.map((c: any) => c?.text ?? "").join("")
    : String(content);
}

describe("openai endpoint + structured-output transport", () => {
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
    return {
      ...compat,
      model: (baseURL: string, useChat = true) => {
        const o = createOpenAI({ apiKey: "k", baseURL });
        return compat.applyStructuredOutputPolicy(
          useChat ? o.chat("test-model") : o.responses("test-model"),
          compat.structuredOutputModeSync() as "strict" | "tool",
        );
      },
    };
  }

  const BASE = { OPENAI_API_KEY: "test-key", MODEL_NAME: "test-model" };
  const chats = (b: typeof backend) =>
    b!.requests.filter(r => r.url.endsWith("/chat/completions"));
  /** Last non-probe chat request, i.e. the real structured call. */
  const lastCall = (b: typeof backend) =>
    chats(b)
      .filter(r => r.body.tools?.[0]?.function?.name !== "probe")
      .at(-1);

  // ---------------------------------------------------------------- official

  describe("official OpenAI", () => {
    it("never probes and stays on Responses + strict", async () => {
      const probe = vi.spyOn(globalThis, "fetch");
      const p = await load(BASE);

      await expect(p.resolveApiMode("m")).resolves.toBe("responses");
      await expect(p.resolveStructuredOutputMode("m")).resolves.toBe("strict");
      expect(probe).not.toHaveBeenCalled();
      expect(p.apiModeSync()).toBe("responses");
      expect(p.structuredOutputModeSync()).toBe("strict");
      probe.mockRestore();
    });

    it("recognises an explicit openai.com base URL as official", async () => {
      const probe = vi.spyOn(globalThis, "fetch");
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      });
      expect(p.isOfficialOpenAiEndpoint()).toBe(true);
      await expect(p.resolveApiMode()).resolves.toBe("responses");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });

    it("emits native strict json_schema and receives no tool wrapper", async () => {
      backend = await startBackend();
      const p = await load(BASE);
      await Promise.resolve(
        p.model(backend.baseURL, false).doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Extract." }] },
          ],
          mode: "json",
          responseFormat: { type: "json", name: "response", schema: SCHEMA },
        } as any),
      ).catch(() => {});

      const sent = backend.requests
        .filter(r => r.url.endsWith("/responses"))
        .at(-1)!;
      expect(sent.url).toContain("/responses");
      expect(sent.body.text.format.type).toBe("json_schema");
      expect(sent.body.text.format.strict).toBe(true);
      // Official OpenAI must never receive the tool compatibility transport.
      expect(JSON.stringify(sent.body)).not.toContain(
        "firecrawl_structured_output",
      );
      expect(sent.body.tools).toBeUndefined();
    });
  });

  // ----------------------------------------------------------- endpoint mode

  describe("endpoint detection (auto)", () => {
    it("keeps Responses when supported", async () => {
      backend = await startBackend();
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveApiMode("m")).resolves.toBe("responses");
    });

    it.each([404, 405, 501])("selects Chat on HTTP %i", async status => {
      backend = await startBackend({
        onResponses: res => json(res, status, { error: { message: "nope" } }),
      });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveApiMode("m")).resolves.toBe("chat");
    });

    it.each([401, 403, 429, 500, 503])(
      "refuses to classify HTTP %i as endpoint absence",
      async status => {
        backend = await startBackend({
          onResponses: res =>
            json(res, status, { error: { message: "operational" } }),
        });
        const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
        await expect(p.resolveApiMode("m")).rejects.toMatchObject({
          name: "OpenAiCapabilityIndeterminateError",
        });
      },
    );

    it("does not treat a connection failure as endpoint absence", async () => {
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      });
      await expect(p.resolveApiMode()).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
    });

    it("explicit responses never falls back", async () => {
      backend = await startBackend({
        onResponses: res => json(res, 404, { error: {} }),
      });
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "responses",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      expect(p.apiModeSync()).toBe("responses");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });

    it("explicit chat never probes Responses", async () => {
      backend = await startBackend();
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_API_MODE: "chat",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(p.resolveApiMode()).resolves.toBe("chat");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });
  });

  // ---------------------------------------------------------------- caches

  describe("capability cache", () => {
    it("probes once across repeated resolution", async () => {
      backend = await startBackend();
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await p.resolveApiMode("m");
      await p.resolveApiMode("m");
      await p.resolveApiMode("m");
      expect(
        backend.requests.filter(r => r.url.endsWith("/responses")).length,
      ).toBe(1);
    });

    it("shares one probe across concurrent callers", async () => {
      backend = await startBackend();
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await Promise.all([
        p.resolveApiMode("m"),
        p.resolveApiMode("m"),
        p.resolveApiMode("m"),
      ]);
      expect(
        backend.requests.filter(r => r.url.endsWith("/responses")).length,
      ).toBe(1);
    });

    it("does not share capability between base URLs", async () => {
      const a = await startBackend();
      const b = await startBackend({
        onResponses: res => json(res, 404, { error: {} }),
      });
      try {
        const p = await load({ ...BASE, OPENAI_BASE_URL: a.baseURL });
        await expect(p.resolveApiMode("m")).resolves.toBe("responses");
        const q = await load({ ...BASE, OPENAI_BASE_URL: b.baseURL });
        await expect(q.resolveApiMode("m")).resolves.toBe("chat");
        const r = await load({ ...BASE, OPENAI_BASE_URL: a.baseURL });
        await expect(r.resolveApiMode("m")).resolves.toBe("responses");
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("keys capability by model too", async () => {
      backend = await startBackend();
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await p.resolveApiMode("model-a");
      await p.resolveApiMode("model-b");
      expect(
        backend.requests.filter(r => r.url.endsWith("/responses")).length,
      ).toBe(2);
    });

    it("never caches an operational failure", async () => {
      let calls = 0;
      backend = await startBackend({
        onResponses: res => {
          calls++;
          return json(res, 503, { error: { message: "down" } });
        },
      });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveApiMode("m")).rejects.toThrow();
      await expect(p.resolveApiMode("m")).rejects.toThrow();
      // A 503 must not become a cached "chat" decision.
      expect(calls).toBe(2);
    });
  });

  // ---------------------------------------------------- structured transport

  describe("automatic structured transport", () => {
    it("uses strict when json_schema is supported", async () => {
      backend = await startBackend();
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveStructuredOutputMode("m")).resolves.toBe("strict");
    });

    it("falls back to tool when json_schema is definitely rejected", async () => {
      backend = await startBackend({ rejectJsonSchema: true });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveStructuredOutputMode("m")).resolves.toBe("tool");
    });

    it("fails closed when neither transport is supported", async () => {
      backend = await startBackend({
        rejectJsonSchema: true,
        rejectTools: true,
      });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveStructuredOutputMode("m")).rejects.toBeInstanceOf(
        p.OpenAiNoStructuredTransportError,
      );
      await expect(p.resolveStructuredOutputMode("m")).rejects.toThrow(
        /supports neither native strict JSON-schema output nor forced tool\/function calling/,
      );
    });

    it("propagates an indeterminate json_schema probe", async () => {
      backend = await startBackend({
        onChat: (res, body) => {
          if (body.response_format?.json_schema?.name === "probe") {
            return json(res, 403, { error: { message: "forbidden" } });
          }
        },
      });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveStructuredOutputMode("m")).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
    });

    it("propagates an indeterminate tool probe", async () => {
      backend = await startBackend({
        rejectJsonSchema: true,
        onChat: (res, body) => {
          if (body.tools?.[0]?.function?.name === "probe") {
            return json(res, 500, { error: { message: "boom" } });
          }
        },
      });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      await expect(p.resolveStructuredOutputMode("m")).rejects.toMatchObject({
        name: "OpenAiCapabilityIndeterminateError",
      });
    });

    it("never selects a prompt-carried schema", async () => {
      backend = await startBackend({ rejectJsonSchema: true });
      const p = await load({ ...BASE, OPENAI_BASE_URL: backend.baseURL });
      const mode = await p.resolveStructuredOutputMode("m");
      expect(mode).toBe("tool");
      expect(mode).not.toBe("prompt");
    });

    it("explicit strict never probes and never falls back", async () => {
      backend = await startBackend({ rejectJsonSchema: true });
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "strict",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(p.resolveStructuredOutputMode()).resolves.toBe("strict");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });

    it("explicit tool never probes", async () => {
      backend = await startBackend();
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      const probe = vi.spyOn(globalThis, "fetch");
      await expect(p.resolveStructuredOutputMode()).resolves.toBe("tool");
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    });
  });

  // ------------------------------------------------------- tool transport

  describe("tool transport request shaping", () => {
    async function toolMode() {
      backend = await startBackend({ toolArgs: { title: "Example.com" } });
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      return p;
    }

    it("sends the schema only as a forced tool, never as json_schema or prompt text", async () => {
      const p = await toolMode();
      const result = await generateObject({
        model: p.model(backend!.baseURL),
        schema: z.object({ title: z.string() }),
        prompt: "Extract the title.",
      });

      const sent = lastCall(backend)!;
      expect(sent.body.tools?.[0]?.function?.name).toBe(
        "firecrawl_structured_output",
      );
      expect(sent.body.tool_choice).toEqual({
        type: "function",
        function: { name: "firecrawl_structured_output" },
      });
      expect(JSON.stringify(sent.body)).not.toContain("json_schema");
      expect(sent.body.response_format).toBeUndefined();
      // The schema must not appear in ordinary prompt content.
      expect(lastUserText(sent.body)).not.toContain('"title"');
      expect(result.object).toEqual({ title: "Example.com" });
    });

    it("forwards annotations in the provider-facing tool schema", async () => {
      const p = await toolMode();
      await Promise.resolve(
        p.model(backend!.baseURL).doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Extract." }] },
          ],
          mode: "json",
          responseFormat: { type: "json", name: "response", schema: SCHEMA },
        } as any),
      ).catch(() => {});
      const params = lastCall(backend)?.body.tools?.[0]?.function?.parameters;
      expect(params?.properties?.title?.description).toBe("The title");
    });

    it("validates tool arguments against the ORIGINAL zod schema", async () => {
      backend = await startBackend({ toolArgs: { title: 12345 } });
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      await expect(
        generateObject({
          model: p.model(backend.baseURL),
          schema: z.object({ title: z.string() }),
          prompt: "Extract.",
        }),
      ).rejects.toThrow();
    });

    it("rejects a non-tool reply rather than trusting it", async () => {
      backend = await startBackend({ chatReply: "I refuse to answer" });
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "tool",
      });
      await expect(
        generateObject({
          model: p.model(backend.baseURL),
          schema: z.object({ title: z.string() }),
          prompt: "Extract.",
        }),
      ).rejects.toThrow();
    });

    it("strict mode still sends native json_schema", async () => {
      backend = await startBackend();
      const p = await load({
        ...BASE,
        OPENAI_BASE_URL: backend.baseURL,
        OPENAI_STRUCTURED_OUTPUT_MODE: "strict",
      });
      await Promise.resolve(
        p.model(backend.baseURL).doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Extract." }] },
          ],
          mode: "json",
          responseFormat: { type: "json", name: "response", schema: SCHEMA },
        } as any),
      ).catch(() => {});
      const sent = lastCall(backend)!;
      expect(sent.body.response_format.type).toBe("json_schema");
      expect(sent.body.tools).toBeUndefined();
    });
  });

  // ------------------------------------------------- validator-regression trap

  it("jsonSchema() alone does NOT validate; the original zod schema does", async () => {
    // jsonSchema() carries no runtime validator, so a wrong-typed value passes
    // through it. This is why the tool path must never treat the provider-side
    // schema as authoritative. Pinned so it cannot silently change.
    const bad = { title: 12345 };
    const viaJsonSchema = await generateObject({
      model: createOpenAI({
        apiKey: "k",
        baseURL: "http://127.0.0.1:9/v1",
      }).chat("m"),
      schema: jsonSchema(SCHEMA as any),
      prompt: "x",
    } as any).catch(() => null);
    // Unreachable backend, so assert on the validators directly instead.
    expect(viaJsonSchema).toBeNull();

    // jsonSchema() admits a wrong type; zod does not.
    const parsedByJsonSchema = await (jsonSchema(SCHEMA as any) as any)
      .validate?.(bad)
      .catch(() => "threw");
    expect(parsedByJsonSchema).not.toBe("threw");

    expect(z.object({ title: z.string() }).safeParse(bad).success).toBe(false);
  });
});
