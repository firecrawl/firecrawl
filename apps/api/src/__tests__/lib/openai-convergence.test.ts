/**
 * Convergence checks that cut across the resolver, the model wrapper and the
 * transport middleware. Each scenario attacks a specific invariant rather
 * than re-testing a single unit.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, jsonSchema } from "ai";
import { z } from "zod";
import * as compat from "../../lib/openai-structured-output.js";
import { config } from "../../config.js";

const mkChat = (base: string) =>
  createOpenAI({ apiKey: "k", baseURL: base }).chat("m");
const js = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

function stub(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const chatText = (t: string) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: t },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const chatTool = (name: string, args: string) => ({
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
          { id: "c1", type: "function", function: { name, arguments: args } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

it("CONVERGENCE: hostile backends", async () => {
  const seen: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch");
  const c = compat;

  // 1. explicit API=chat + auto structured, backend 200 everywhere but ignores tools
  seen.length = 0;
  spy.mockImplementation(async (u: any, i: any) => {
    const b = i?.body ? JSON.parse(i.body) : {};
    if (b.response_format?.json_schema?.name === "probe")
      return stub({ error: { message: "json_schema not supported" } }, 400);
    if (b.tools?.some((t: any) => t.function?.name === "probe"))
      return stub(chatText("Sure, here is JSON: nope"));
    return stub(chatText("plain"));
  });
  c.__resetCapabilityCaches();
  const t1 = { baseURL: "http://a.invalid/v1", modelName: "m" };
  config.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
  await expect(c.resolveStructuredOutputMode(t1, "chat")).rejects.toMatchObject(
    {
      name: "OpenAiCapabilityIndeterminateError",
    },
  );
  seen.push("1: tool-probe-200-but-no-call -> indeterminate");

  // 2. auto API + explicit structured=tool: no probes at all
  spy.mockReset();
  c.__resetCapabilityCaches();
  config.OPENAI_STRUCTURED_OUTPUT_MODE = "tool";
  config.OPENAI_API_MODE = "chat";
  await expect(c.resolveStructuredOutputMode(t1, "chat")).resolves.toBe("tool");
  seen.push("2: explicit tool never probes");

  // 3. two models, different capabilities, one module instance
  spy.mockReset();
  c.__resetCapabilityCaches();
  config.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
  config.OPENAI_API_MODE = "chat";
  spy.mockImplementation(async (u: any, i: any) => {
    const b = i?.body ? JSON.parse(i.body) : {};
    const m = b.model;
    if (b.response_format?.json_schema?.name === "probe")
      return m === "good"
        ? stub(chatText(JSON.stringify({ ok: true })))
        : stub({ error: { message: "json_schema not supported" } }, 400);
    if (b.tools?.some((t: any) => t.function?.name === "probe"))
      return stub(chatTool("probe", JSON.stringify({ ok: true })));
    return stub(chatText("x"));
  });
  const good = await c.resolveStructuredOutputMode(
    { baseURL: "http://b.invalid/v1", modelName: "good" },
    "chat",
  );
  const weak = await c.resolveStructuredOutputMode(
    { baseURL: "http://b.invalid/v1", modelName: "weak" },
    "chat",
  );
  seen.push(`3: model isolation good=${good} weak=${weak}`);
  expect(good).toBe("strict");
  expect(weak).toBe("tool");

  // 4. two surfaces, same model, different capabilities
  c.__resetCapabilityCaches();
  spy.mockReset();
  let surfaceCalls = 0;
  spy.mockImplementation(async (u: any, i: any) => {
    const b = i?.body ? JSON.parse(i.body) : {};
    const isResp = String(u).endsWith("/responses");
    const isStrictProbe =
      b.text?.format?.name === "probe" ||
      b.response_format?.json_schema?.name === "probe";
    const isToolProbe = (b.tools ?? []).some(
      (t: any) => (t.function?.name ?? t.name) === "probe",
    );
    if (isStrictProbe) {
      surfaceCalls++;
      return isResp
        ? stub(
            { error: { message: "text.format json_schema is not supported" } },
            400,
          )
        : stub(chatText(JSON.stringify({ ok: true })));
    }
    if (isToolProbe) {
      // The Responses surface supports the probe tool.
      return stub(
        isResp
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
                  name: "probe",
                  arguments: JSON.stringify({ ok: true }),
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }
          : chatTool("probe", JSON.stringify({ ok: true })),
      );
    }
    return stub(chatText("x"));
  });
  const onChat = await c
    .resolveStructuredOutputMode(
      { baseURL: "http://d.invalid/v1", modelName: "m" },
      "chat",
    )
    .catch((e: any) => `ERR:${e.name}`);
  const onResp = await c
    .resolveStructuredOutputMode(
      { baseURL: "http://d.invalid/v1", modelName: "m" },
      "responses",
    )
    .catch((e: any) => `ERR:${e.name}:${e.reason?.slice(0, 60)}`);
  seen.push(
    `4: surface isolation chat=${onChat} responses=${String(onResp).slice(0, 90)}`,
  );
  expect(onChat).toBe("strict");
  expect(onResp).toBe("tool"); // responses surface: strict rejected, tools honoured

  // 5. multiple tool calls -> rejected deterministically
  c.__resetCapabilityCaches();
  const dup = {
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
              id: "1",
              type: "function",
              function: {
                name: "firecrawl_structured_output",
                arguments: '{"title":"a"}',
              },
            },
            {
              id: "2",
              type: "function",
              function: {
                name: "firecrawl_structured_output",
                arguments: '{"title":"b"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  spy.mockReset();
  spy.mockImplementation(async () => stub(dup));
  await expect(
    generateObject({
      model: c.applyStructuredOutputPolicy(
        mkChat("http://e.invalid/v1"),
        "tool",
      ),
      schema: jsonSchema(js as any),
      prompt: "x",
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ name: "OpenAiToolTransportViolationError" });
  seen.push("5: duplicate tool calls rejected");

  console.log(seen.join("\n"));
}, 120000);
