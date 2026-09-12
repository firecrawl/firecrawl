import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/connection";
import { exchangeRequest } from "./client";
import { refusal, type ProviderCall } from "./contracts";

const requirementsSchema = z.object({
  providers: z.array(
    z
      .object({
        provider: z.string(),
        required: z.boolean(),
        terms: z
          .object({
            key: z.string(),
            version: z.string(),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .nullable(),
      })
      .refine(item => !item.required || item.terms !== null),
  ),
});
const rowsSchema = z
  .array(
    z.object({
      org_id: z.string(),
      data_source_id: z.string().nullable(),
      status: z.string().nullable(),
      terms_key: z.string().nullable(),
      terms_version: z.string().nullable(),
      terms_accepted_at: z.unknown(),
      settings: z.record(z.string(), z.unknown()).nullable(),
    }),
  )
  .min(1);

export async function authorizeProviders(
  teamId: string,
  calls: ProviderCall[],
) {
  const providers = [...new Set(calls.map(call => call.provider))];
  const response = await exchangeRequest({
    teamId,
    path: "/v1/provider-terms/requirements",
    body: { providers },
    timeoutMs: 10000,
  });
  const parsed = requirementsSchema.safeParse(response.body);
  if (
    response.status !== 200 ||
    !parsed.success ||
    parsed.data.providers.length !== providers.length ||
    new Set(parsed.data.providers.map(item => item.provider)).size !==
      providers.length ||
    parsed.data.providers.some(item => !providers.includes(item.provider))
  )
    return refusal(
      503,
      "Provider agreements are unavailable. No provider was executed.",
    );

  // Primary reads make organization disablement and agreement changes effective immediately.
  const result = await db.execute(sql`
    SELECT t.org_id, a.data_source_id, a.status, a.terms_key, a.terms_version, a.terms_accepted_at, a.settings
    FROM teams t LEFT JOIN organization_data_source_access a ON a.org_id = t.org_id
      AND a.data_source_id IN (${sql.join(
        providers.map(provider => sql`${provider}`),
        sql`, `,
      )})
    WHERE t.id = ${teamId}
  `);
  const rows = rowsSchema.parse(result.rows);
  for (const provider of parsed.data.providers) {
    const row = rows.find(row => row.data_source_id === provider.provider);
    if (row && row.status !== "enabled")
      return refusal(
        403,
        `Access to ${provider.provider} is disabled for this organization.`,
      );
    if (
      provider.required &&
      (!row?.terms_accepted_at ||
        row.terms_key !== provider.terms?.key ||
        row.terms_version !== provider.terms?.version ||
        row.settings?.terms_digest !== provider.terms?.digest)
    )
      return refusal(
        403,
        `An organization admin must accept the current ${provider.provider} agreement before this tool can run.`,
      );
  }
}
