import { z } from "zod";
import { exchangeRequest } from "./client";
import { refusal, type ExchangeResponse } from "./contracts";

const TIMEOUT_MS = 10_000;

export const acceptTermsSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  agent: z
    .strictObject({
      name: z.string().min(1).max(200),
      vendor: z.string().max(200).optional(),
      runId: z.string().max(200).optional(),
    })
    .optional(),
});
type AcceptTerms = z.infer<typeof acceptTermsSchema>;

const requirementsSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      required: z.boolean(),
      exchangeRequired: z.boolean().optional(),
      terms: z
        .object({
          key: z.string(),
          version: z.string(),
          digest: z.string(),
          schedule: z.string().optional(),
        })
        .passthrough()
        .nullable(),
    }),
  ),
});

const statusSchema = z.object({
  providers: z.array(
    z
      .object({
        provider: z.string(),
        version: z.string().nullable(),
        textHash: z.string().nullable(),
        revoked: z.boolean(),
        acceptedAt: z.unknown().optional(),
      })
      .passthrough(),
  ),
});

export type LedgerAcceptance = {
  version: string;
  textHash: string | null;
  acceptedAt?: string | null;
};

const timestampSchema = z.iso.datetime({ offset: true });

function timestamp(value: unknown): number {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : NaN;
}

export function matchesAcceptance(
  accepted: LedgerAcceptance | undefined,
  terms: { version: string; digest?: string },
): boolean {
  return (
    terms.digest !== undefined &&
    accepted?.version === terms.version &&
    accepted.textHash === terms.digest
  );
}

// Whether the acceptance was recorded after `since`, e.g. an admin revocation
// it has to lift. Unparseable timestamps never qualify.
export function acceptedAfter(
  accepted: LedgerAcceptance | undefined,
  since: unknown,
): boolean {
  const acceptedAt = timestamp(accepted?.acceptedAt);
  const sinceAt = timestamp(since);
  return (
    Number.isFinite(acceptedAt) &&
    Number.isFinite(sinceAt) &&
    acceptedAt > sinceAt
  );
}

export async function acceptedProviders(
  teamId: string,
  orgId: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Map<string, LedgerAcceptance>> {
  const response = await exchangeRequest({
    teamId,
    path: `/v1/provider-terms/status?organizationId=${encodeURIComponent(orgId)}`,
    timeoutMs,
  }).catch(() => undefined);
  const parsed =
    response?.status === 200
      ? statusSchema.safeParse(response.body)
      : undefined;
  const accepted = new Map<string, LedgerAcceptance>();
  if (!parsed?.success) return accepted;
  for (const item of parsed.data.providers) {
    if (!item.revoked && item.version)
      accepted.set(item.provider, {
        version: item.version,
        textHash: item.textHash,
        acceptedAt:
          typeof item.acceptedAt === "string" ? item.acceptedAt : null,
      });
  }
  return accepted;
}

/**
 * Whether the organization's ledger on the Exchange holds an acceptance of the
 * provider's current terms, recorded after `revocation.disabledAt` when an
 * admin revocation has to be lifted. The API's accept route records
 * acceptance only there. Any failure reads as not accepted.
 */
export async function hasLedgerAcceptance(input: {
  teamId: string;
  orgId: string;
  provider: string;
  revocation?: { disabledAt: unknown };
  timeoutMs: number;
}): Promise<boolean> {
  const [requirements, ledger] = await Promise.all([
    exchangeRequest({
      teamId: input.teamId,
      path: "/v1/provider-terms/requirements",
      body: { providers: [input.provider] },
      timeoutMs: input.timeoutMs,
    }).catch(() => undefined),
    acceptedProviders(input.teamId, input.orgId, input.timeoutMs),
  ]);
  const parsed =
    requirements?.status === 200
      ? requirementsSchema.safeParse(requirements.body)
      : undefined;
  const terms = parsed?.success
    ? parsed.data.providers.find(item => item.provider === input.provider)
        ?.terms
    : undefined;
  if (!terms) return false;
  const accepted = ledger.get(input.provider);
  return (
    matchesAcceptance(accepted, terms) &&
    (input.revocation === undefined ||
      acceptedAfter(accepted, input.revocation.disabledAt))
  );
}

export async function acceptProviderTerms(input: {
  teamId: string;
  orgId: string;
  apiKeyId: string | null;
  body: AcceptTerms;
}): Promise<ExchangeResponse> {
  const { provider, version, digest, agent } = input.body;
  const requirements = await exchangeRequest({
    teamId: input.teamId,
    path: "/v1/provider-terms/requirements",
    body: { providers: [provider] },
    timeoutMs: TIMEOUT_MS,
  }).catch(() => undefined);
  if (requirements?.status === 404)
    return refusal(404, "Unknown provider.", { code: "unknown_provider" });
  const parsed =
    requirements?.status === 200
      ? requirementsSchema.safeParse(requirements.body)
      : undefined;
  const item = parsed?.success
    ? parsed.data.providers.find(entry => entry.provider === provider)
    : undefined;
  if (!item)
    return refusal(
      503,
      "Provider agreements are unavailable. Nothing was accepted.",
    );
  if (!(item.required || item.exchangeRequired) || !item.terms)
    return refusal(400, `${provider} requires no agreement.`);
  if (item.terms.version !== version || item.terms.digest !== digest)
    return refusal(
      409,
      "Terms changed. Review the current version before accepting.",
      {
        code: "terms_changed",
        provider,
        version: item.terms.version,
        digest: item.terms.digest,
      },
    );

  const event = await exchangeRequest({
    teamId: input.teamId,
    path: "/v1/provider-terms/events",
    body: {
      organization_id: input.orgId,
      data_source_id: provider,
      event_type: "accepted",
      schedule: item.terms.schedule ?? null,
      version,
      text_hash: digest,
      actor_type: "agent",
      credential_id: input.apiKeyId,
      agent_descriptor: agent ?? null,
      surface: "api",
    },
    timeoutMs: TIMEOUT_MS,
  }).catch(() => undefined);
  const recorded = z
    .object({ id: z.string(), occurred_at: z.string() })
    .safeParse(event?.status === 201 ? event.body : undefined);
  if (!recorded.success)
    return refusal(
      503,
      "Provider terms acceptance is unavailable. Nothing was accepted.",
    );
  return {
    status: 200,
    body: {
      success: true,
      provider,
      version,
      digest,
      acceptedAt: recorded.data.occurred_at,
    },
  };
}
