/**
 * Request-resolution behaviour for OpenAI-provider models.
 *
 * Two separations matter and are easy to regress:
 *
 *   1. plain-text generation must not depend on structured capability, so a
 *      backend that serves ordinary text but no schema/tools still works;
 *   2. OPENAI_API_MODE and OPENAI_STRUCTURED_OUTPUT_MODE are independent, and
 *      an explicit API mode must not imply a structured transport.
 */

import { generateObject, generateText } from "ai";
import { z } from "zod";

// Mutable stand-in for the parsed config. vi.hoisted so the mock factory can
// close over it, and typed as the real config would be so assignments stay
// honest.
const mutableConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: "k" as string | undefined,
  OPENAI_BASE_URL: undefined as string | undefined,
  MODEL_NAME: undefined as string | undefined,
  OPENAI_API_MODE: undefined as "auto" | "chat" | "responses" | undefined,
  OPENAI_STRUCTURED_OUTPUT_MODE: undefined as
    | "auto"
    | "strict"
    | "tool"
    | undefined,
  OLLAMA_BASE_URL: undefined as string | undefined,
  OPENROUTER_API_KEY: undefined as string | undefined,
  VERTEX_CREDENTIALS: undefined as string | undefined,
  MODEL_EMBEDDING_NAME: undefined as string | undefined,
}));

vi.mock("../../config", () => ({ config: mutableConfig }));

const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_API_MODE",
  "OPENAI_STRUCTURED_OUTPUT_MODE",
  "MODEL_NAME",
] as const;

const savedEnv: Record<string, string | undefined> = {};
let compat: typeof import("../../lib/openai-structured-output.js");

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  compat = await import("../../lib/openai-structured-output.js");
  compat.__resetCapabilityCaches();
  mutableConfig.OPENAI_BASE_URL = undefined;
  mutableConfig.MODEL_NAME = undefined;
  mutableConfig.OPENAI_API_MODE = undefined;
  mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = undefined;
  vi.restoreAllMocks();
});

/** Count outbound probes so we can assert which capability work happened. */
function spyFetch() {
  const calls: { url: string; body: any }[] = [];
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation((async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    const isResponses = String(url).endsWith("/responses");
    const isStrict = Boolean(
      body.text?.format ?? body.response_format?.json_schema,
    );
    const isTool = Boolean(body.tools);
    if (isStrict) {
      const text = JSON.stringify({ ok: true });
      return new Response(
        JSON.stringify(
          isResponses
            ? {
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
              }
            : {
                id: "c",
                object: "chat.completion",
                created: 1,
                model: "m",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (isTool) {
      const name = (body.tools[0].function?.name ??
        body.tools[0].name) as string;
      const args = JSON.stringify(
        name === "probe" ? { ok: true } : { title: "T" },
      );
      return new Response(
        JSON.stringify(
          isResponses
            ? {
                id: "r",
                object: "response",
                status: "completed",
                created_at: 1,
                output: [
                  {
                    type: "function_call",
                    id: "f1",
                    call_id: "c1",
                    name,
                    arguments: args,
                  },
                ],
              }
            : {
                id: "c",
                object: "chat.completion",
                created: 1,
                model: "m",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "c1",
                          type: "function",
                          function: { name, arguments: args },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Plain text.
    return new Response(
      JSON.stringify(
        isResponses
          ? {
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
            }
          : {
              id: "c",
              object: "chat.completion",
              created: 1,
              model: "m",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hello" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any);
  return { spy, calls };
}

describe("OpenAI request resolution", () => {
  it("A: plain text on a structured-incapable backend succeeds with no structured probe", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://custom.invalid/v1";
    mutableConfig.MODEL_NAME = "custom-model";
    const { spy, calls } = spyFetch();
    // Endpoint probe 404s -> chat; structured probes 404 as well.
    spy
      .mockImplementationOnce(async () => new Response("{}", { status: 404 }))
      .mockImplementation(async (url: any) =>
        String(url).endsWith("/responses")
          ? new Response("{}", { status: 404 })
          : new Response(
              JSON.stringify({
                id: "c",
                object: "chat.completion",
                created: 1,
                model: "m",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "hello" },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
      );

    const { getModel } = await import("../../lib/generic-ai.js");
    const result = await generateText({
      model: getModel("gpt-4o-mini", "openai"),
      prompt: "hi",
    });
    expect(result.text).toBe("hello");
    // No structured or tool probe may have been issued.
    const structuredProbes = calls.filter(
      c => c.body.response_format || c.body.text?.format || c.body.tools,
    );
    expect(structuredProbes).toHaveLength(0);
  });

  it("B: explicit chat + auto structured still resolves structured on chat", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://custom.invalid/v1";
    mutableConfig.MODEL_NAME = "custom-model";
    mutableConfig.OPENAI_API_MODE = "chat";
    mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
    const { spy, calls } = spyFetch();
    // Strict probe definitively rejected, tool probe honoured.
    spy.mockImplementation(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ url: String(url), body });
      if (body.response_format?.json_schema?.name === "probe") {
        return new Response(
          JSON.stringify({
            error: { message: "json_schema is not supported" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (body.tools) {
        const name = body.tools[0].function?.name ?? body.tools[0].name;
        // A capability probe must satisfy its own contract; the real call does not.
        const isProbe = name === "probe";
        return new Response(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name,
                        arguments: JSON.stringify(
                          isProbe ? { ok: true } : { title: "T" },
                        ),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 500 });
    });

    const { getModel } = await import("../../lib/generic-ai.js");
    const result = await generateObject({
      model: getModel("gpt-4o-mini", "openai"),
      schema: z.object({ title: z.string() }),
      prompt: "extract",
    });
    expect(result.object).toEqual({ title: "T" });
    // Endpoint probe must NOT have happened (explicit chat).
    expect(calls.some(c => c.url.endsWith("/responses"))).toBe(false);
    // Strict then tool probes happened on chat.
    expect(
      calls.some(
        c =>
          c.url.includes("/chat/completions") &&
          c.body.response_format?.json_schema?.name === "probe",
      ),
    ).toBe(true);
    expect(
      calls.some(
        c =>
          c.url.includes("/chat/completions") &&
          c.body.tools?.some(
            (t: any) => (t.function?.name ?? t.name) === "probe",
          ),
      ),
    ).toBe(true);
  });

  it("C: o3-mini forces chat but still resolves structured transport", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://custom.invalid/v1";
    mutableConfig.MODEL_NAME = "o3-mini-custom";
    mutableConfig.OPENAI_API_MODE = undefined;
    mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
    const { spy, calls } = spyFetch();
    spy.mockImplementation(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ url: String(url), body });
      // Strict unsupported, tool supported.
      if (body.response_format?.json_schema?.name === "probe") {
        return new Response(
          JSON.stringify({
            error: { message: "json_schema is not supported" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (body.tools) {
        const name = body.tools[0].function?.name ?? body.tools[0].name;
        // A capability probe must satisfy its own contract; the real call does not.
        const isProbe = name === "probe";
        return new Response(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name,
                        arguments: JSON.stringify(
                          isProbe ? { ok: true } : { title: "T" },
                        ),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 500 });
    });

    const { getModel } = await import("../../lib/generic-ai.js");
    const result = await generateObject({
      model: getModel("o3-mini", "openai"),
      schema: z.object({ title: z.string() }),
      prompt: "extract",
    });
    expect(result.object).toEqual({ title: "T" });
    // o3-mini must use chat, and must have done a structured (tool) probe.
    expect(calls.every(c => c.url.includes("/chat/completions"))).toBe(true);
    expect(
      calls.some(c =>
        c.body.tools?.some(
          (t: any) => (t.function?.name ?? t.name) === "probe",
        ),
      ),
    ).toBe(true);
  });

  it("J: does not apply OpenAI modes to non-OpenAI providers", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://custom.invalid/v1";
    mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = "tool";
    mutableConfig.OPENAI_API_MODE = "chat";
    const { spy, calls } = spyFetch();

    // The Ollama provider (default when OLLAMA_BASE_URL set) is not OpenAI.
    mutableConfig.OLLAMA_BASE_URL = "http://ollama.invalid";
    const { getModel } = await import("../../lib/generic-ai.js");
    const model = getModel("llama3");
    // An Ollama model must not be wrapped in the Firecrawl tool transport.
    // We assert on provider identity and the absence of Firecrawl tooling.
    expect(model.provider).not.toContain("firecrawl_structured_output");
    // No OpenAI probes at all.
    expect(calls).toHaveLength(0);
  });

  it("I: retries capability after a transient failure using the same model handle", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://custom.invalid/v1";
    mutableConfig.MODEL_NAME = "custom-model";
    mutableConfig.OPENAI_API_MODE = "responses";
    mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
    const { spy } = spyFetch();
    // One failing structured probe on the Responses surface, then success.
    let failOnce = true;
    spy.mockImplementation(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.text?.format?.name === "probe" && failOnce) {
        failOnce = false;
        return new Response(
          JSON.stringify({ error: { message: "unavailable" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (body.text?.format?.name === "probe") {
        const text = JSON.stringify({ ok: true });
        return new Response(
          JSON.stringify({
            id: "r",
            object: "response",
            status: "completed",
            created_at: 1,
            output: [
              {
                type: "message",
                id: "msg_1",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text, annotations: [], logprobs: [] },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // The actual strict application call (not a probe).
      const text = JSON.stringify({ title: "T" });
      return new Response(
        JSON.stringify({
          id: "r",
          object: "response",
          status: "completed",
          created_at: 1,
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [
                { type: "output_text", text, annotations: [], logprobs: [] },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { getModel } = await import("../../lib/generic-ai.js");
    const model = getModel("gpt-4o-mini", "openai");
    // First structured request hits the transient failure.
    await expect(
      generateObject({
        model,
        schema: z.object({ title: z.string() }),
        prompt: "x",
      }),
    ).rejects.toThrow();
    // Same handle must recover on the next request.
    const result = await generateObject({
      model,
      schema: z.object({ title: z.string() }),
      prompt: "x",
    });
    expect(result.object).toEqual({ title: "T" });
  });
});
