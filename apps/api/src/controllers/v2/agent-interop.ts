import { z } from "zod";

function softOptional<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const agentInteropSchema = z.object({
  shouldBill: softOptional(z.boolean()),
  requestId: softOptional(z.string()),
  boostConcurrency: softOptional(z.boolean()),
});

const agentInteropBodySchema = z.object({
  __agentInterop: agentInteropSchema,
});

export type AgentInteropPayload = z.infer<typeof agentInteropSchema>;

/** Extracts the internal `__agentInterop` payload from a request body. */
export function readAgentInterop(
  body: unknown,
): AgentInteropPayload | undefined {
  const parsed = agentInteropBodySchema.safeParse(body);
  return parsed.success ? parsed.data.__agentInterop : undefined;
}

const booleanFieldSchemas = {
  agentIndexOnly: z
    .object({ agentIndexOnly: z.boolean() })
    .transform(value => value.agentIndexOnly),
  lockdown: z
    .object({ lockdown: z.boolean() })
    .transform(value => value.lockdown),
  __experimental_cache: z
    .object({ __experimental_cache: z.boolean() })
    .transform(value => value.__experimental_cache),
  domainTools: z
    .object({ domainTools: z.boolean() })
    .transform(value => value.domainTools),
  highlights: z
    .object({ highlights: z.boolean() })
    .transform(value => value.highlights),
  useIndex: z
    .object({ useIndex: z.boolean() })
    .transform(value => value.useIndex),
  ignoreCache: z
    .object({ ignoreCache: z.boolean() })
    .transform(value => value.ignoreCache),
} satisfies Record<string, z.ZodType<boolean>>;

export type BooleanFieldKey = keyof typeof booleanFieldSchemas;

/** Reads an optional boolean property from an unknown object. */
export function readOptionalBooleanField(
  source: unknown,
  key: BooleanFieldKey,
): boolean | undefined {
  const parsed = booleanFieldSchemas[key].safeParse(source);
  return parsed.success ? parsed.data : undefined;
}

/** Returns whether an unknown object has the named property set to `true`. */
export function readBooleanField(
  source: unknown,
  key: BooleanFieldKey,
): boolean {
  return readOptionalBooleanField(source, key) === true;
}
