import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
function refusal(status: number, error: string) {
  return { status, body: { success: false, error } };
}
const callSchema = z.object({ provider: z.string().min(1) }).passthrough();
const batchSchema = z
  .object({ requests: z.array(callSchema).min(1).max(10) })
  .passthrough();

const requirementsSchema = z.object({
  providers: z.array(
    z
      .object({
        provider: z.string().min(1),
        required: z.boolean(),
        terms: z
          .object({
            key: z.string().min(1),
            version: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .nullable(),
      })
      .refine(item => !item.required || item.terms !== null),
  ),
});
const accessRows = z.array(
  z.object({
    org_id: z.string().nullable(),
    data_source_id: z.string().nullable(),
    status: z.string().nullable(),
    terms_key: z.string().nullable(),
    terms_version: z.string().nullable(),
    terms_accepted_at: z.unknown(),
    settings: z.record(z.string(), z.unknown()).nullable(),
  }),
);

export async function authorizeExchangeProviders(input: {
  teamId: string;
  body: unknown;
  requirements: (
    providers: string[],
  ) => Promise<{ status: number; body: unknown }>;
}) {
  const batch =
    typeof input.body === "object" &&
    input.body !== null &&
    "requests" in input.body;
  const parsedBody = (batch ? batchSchema : callSchema).safeParse(input.body);
  if (!parsedBody.success)
    return refusal(
      400,
      "Provide a provider or a batch of 1–10 provider requests.",
    );
  const calls = batch
    ? (parsedBody.data as z.infer<typeof batchSchema>).requests
    : [parsedBody.data as z.infer<typeof callSchema>];
  const providers = [...new Set(calls.map(call => call.provider))];
  const upstream = await input.requirements(providers);
  if (upstream.status < 200 || upstream.status >= 300)
    return refusal(
      upstream.status === 404 ? 404 : 503,
      upstream.status === 404
        ? "Provider not found or agreement service unavailable."
        : "Unable to verify provider agreements. No provider was executed.",
    );
  const parsed = requirementsSchema.safeParse(upstream.body);
  if (
    !parsed.success ||
    parsed.data.providers.length !== providers.length ||
    new Set(parsed.data.providers.map(item => item.provider)).size !==
      providers.length ||
    parsed.data.providers.some(item => !providers.includes(item.provider))
  )
    return refusal(
      503,
      "Unable to verify provider agreements. No provider was executed.",
    );
  try {
    // Read the primary database so disabling access does not wait for an auth-cache refresh.
    const result = await db.execute(sql`
      SELECT t.org_id, a.data_source_id, a.status, a.terms_key, a.terms_version,
             a.terms_accepted_at, a.settings
      FROM teams t
      LEFT JOIN organization_data_source_access a ON a.org_id = t.org_id
        AND a.data_source_id IN (${sql.join(
          providers.map(provider => sql`${provider}`),
          sql`, `,
        )})
      WHERE t.id = ${input.teamId}
    `);
    const parsedRows = accessRows.safeParse(result.rows);
    if (
      !parsedRows.success ||
      !parsedRows.data.length ||
      !parsedRows.data[0]?.org_id
    )
      return refusal(
        503,
        "Organization provider access is unavailable. No provider was executed.",
      );
    const rows = new Map(parsedRows.data.map(row => [row.data_source_id, row]));
    for (const provider of parsed.data.providers) {
      const row = rows.get(provider.provider);
      if (row && row.status !== "enabled")
        return refusal(
          403,
          `Access to ${provider.provider} is disabled for this organization.`,
        );
      if (
        provider.required &&
        (!row ||
          !row.terms_accepted_at ||
          row.terms_key !== provider.terms?.key ||
          row.terms_version !== provider.terms?.version ||
          row.settings?.terms_digest !== provider.terms?.digest)
      )
        return refusal(
          403,
          `An organization admin must accept the current ${provider.provider} agreement in provider settings before this tool can run.`,
        );
    }
  } catch {
    return refusal(
      503,
      "Organization provider access is unavailable. No provider was executed.",
    );
  }
}
