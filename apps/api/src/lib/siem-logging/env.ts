import { z } from "zod";
import { defineEnv } from "../../service/env";

// Organization SIEM logging delivery. The encryption key must decode to
// exactly 32 bytes; validation happens when a secret is encrypted/decrypted
// so self-hosted deployments that do not use this feature need no key.
export const siemEnv = defineEnv(
  "siem",
  z.object({
    SIEM_LOGGING_ENCRYPTION_KEY: z.string().optional(),
    PARTNER_EGRESS_PROXY_URL: z.string().url().optional(),
  }),
);
