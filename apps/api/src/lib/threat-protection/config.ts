import { z } from "zod";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  type ThreatProtectionPolicy,
} from "./types";

// =========================================
// Field schemas
// =========================================

// One DNS label: alphanumeric, optionally with inner hyphens, max 63 chars.
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Plain domain ("example.com", "sub.example.co.uk") or a single leading
// wildcard label ("*.example.com"). No protocol, path, port, or inner "*".
const DOMAIN_GLOB_REGEX = new RegExp(
  `^(\\*\\.)?(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`,
);

const domainGlobSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => value.length <= 253 && DOMAIN_GLOB_REGEX.test(value), {
    error: iss =>
      `Invalid domain entry ${JSON.stringify(iss.input)}: must be a plain domain like "example.com" or a wildcard glob like "*.example.com" (no protocol, path, or port)`,
  });

const tldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => /^[a-z0-9]{1,63}$/.test(value), {
    error: iss =>
      `Invalid TLD ${JSON.stringify(iss.input)}: must be a lowercase alphanumeric TLD without the leading dot, e.g. "zip"`,
  });

// A single DNS label, as used for the Zidentity vanity domain
// (<vanityDomain>.zslogin.net) and the optional OneAPI cloud name
// (api.<cloud>.zsapi.net).
const dnsLabelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => new RegExp(`^${DOMAIN_LABEL}$`).test(value), {
    error: iss =>
      `Invalid value ${JSON.stringify(iss.input)}: must be a single DNS label (letters, digits, inner hyphens)`,
  });

/**
 * Zscaler category IDs: predefined ("GAMBLING", "OTHER_ADULT_MATERIAL") and
 * custom ("CUSTOM_01") IDs are uppercase with digits/underscores.
 */
const zscalerCategoryIdSchema = z
  .string()
  .trim()
  .refine(value => /^[A-Z0-9_]{1,128}$/.test(value), {
    error: iss =>
      `Invalid category ID ${JSON.stringify(iss.input)}: must be an uppercase Zscaler category ID like "GAMBLING" or "CUSTOM_01"`,
  });

/**
 * Zscaler connection + policy block, accepted by
 * `PUT /v2/team/threat-protection` when the org uses mode "zscaler".
 *
 * `clientSecret` is write-only: it is encrypted at rest, never serialized
 * back, and may be omitted on update to keep the stored secret (only when
 * `clientId` is unchanged — pairing a new client ID with an old secret is
 * always a mistake).
 */
export const zscalerConfigSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(256),
  // Not trimmed (the secret is stored verbatim), but a whitespace-only value
  // must not be persisted as a "configured" secret that can never mint tokens.
  clientSecret: z
    .string()
    .min(1)
    .max(1024)
    .refine(value => value.trim().length > 0, {
      error: "clientSecret must not be blank",
    })
    .optional(),
  /** Zidentity vanity domain: tokens come from https://<vanityDomain>.zslogin.net */
  vanityDomain: dnsLabelSchema,
  /** Optional OneAPI cloud name (api.<cloud>.zsapi.net); null = default cloud. */
  cloud: dnsLabelSchema.nullable().prefault(null),
  deniedCategories: z.array(zscalerCategoryIdSchema).max(512).prefault([]),
  /** How often the category taxonomy + custom lists re-sync. */
  syncIntervalMinutes: z.number().int().min(5).max(1440).prefault(60),
});

type ZscalerConfigInput = z.infer<typeof zscalerConfigSchema>;

// =========================================
// Policy + org config schemas
// =========================================

/**
 * Field-for-field zod schema for {@link ThreatProtectionPolicy}. Every field
 * except `mode` defaults to {@link THREAT_PROTECTION_POLICY_DEFAULTS}.
 */
export const threatProtectionPolicySchema = z.strictObject({
  mode: z.enum(["off", "normal", "zscaler"]),
  riskScoreThreshold: z
    .number()
    .int()
    .min(0)
    .max(100)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.riskScoreThreshold),
  blacklist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blacklist),
  whitelist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.whitelist),
  blockedTlds: z
    .array(tldSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blockedTlds),
  failurePolicy: z
    .enum(["open", "closed"])
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.failurePolicy),
});

// Compile-time assertion that the schema output matches the shared contract
// in ./types.ts — fails to typecheck if the two drift apart.
const _policyContractCheck = (
  x: z.infer<typeof threatProtectionPolicySchema>,
): ThreatProtectionPolicy => x;
void _policyContractCheck;

/**
 * Per-request `threatProtection` option: a field-level override of the org
 * config. Mirrors {@link threatProtectionPolicySchema} but every field is
 * optional and NO defaults are injected — only fields the caller explicitly
 * provides replace the org policy's values (see `resolveEffectivePolicy`).
 */
export const threatProtectionOverrideSchema = z.strictObject({
  mode: z.enum(["off", "normal", "zscaler"]).optional(),
  riskScoreThreshold: z.number().int().min(0).max(100).optional(),
  blacklist: z.array(domainGlobSchema).max(1000).optional(),
  whitelist: z.array(domainGlobSchema).max(1000).optional(),
  blockedTlds: z.array(tldSchema).max(1000).optional(),
  failurePolicy: z.enum(["open", "closed"]).optional(),
});

type ThreatProtectionOverride = z.infer<typeof threatProtectionOverrideSchema>;

// Compile-time assertion that the override shape stays assignable to what
// `resolveEffectivePolicy` consumes. The Omit is deliberate: the Zscaler
// connection is org-owned and never request-settable, and typing it out of
// the override surface makes passing one a compile error instead of a
// silently ignored field.
const _overrideContractCheck = (
  x: ThreatProtectionOverride,
): Partial<Omit<ThreatProtectionPolicy, "zscaler">> => x;
void _overrideContractCheck;

/**
 * Full org-level configuration document, as accepted by
 * `PUT /v2/team/threat-protection`.
 */
export const threatProtectionConfigSchema = threatProtectionPolicySchema.extend(
  {
    allowRequestOverrides: z.boolean().prefault(true),
    /**
     * Zscaler connection block. Absent = no Zscaler connection (clears any
     * stored one, consistent with the full-document PUT semantics). Required
     * when mode is "zscaler" — enforced in the controller, where the stored
     * secret is available for the omitted-secret update path.
     */
    zscaler: zscalerConfigSchema.optional(),
  },
);

export type ThreatProtectionConfigInput = z.infer<
  typeof threatProtectionConfigSchema
>;
