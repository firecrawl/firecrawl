import { z } from "zod";
import { emptyStringAsUndefined } from "../config-helpers";
import { defineEnv } from "../service/env";
import { getMcpActionLogConfigErrors } from "./mcp-action-log-config";

export const mcpLogsEnv = defineEnv(
  "mcp-logs",
  z
    .object({
      MCP_ACTION_LOG_SECRET: z.string().optional(),
      MCP_ACTION_LOG_STORAGE_ENABLED: z.stringbool().default(false),
      MCP_ACTION_LOG_WRITES_ENABLED: z.stringbool().default(false),
      // Comma-separated https URL prefixes, each ending in "/". Besides the
      // canonical hosted MCP URLs, an action log may name a resource made of one
      // of these, a deployment name and a canonical MCP path.
      MCP_ACTION_LOG_RESOURCE_PREFIXES: emptyStringAsUndefined(
        z
          .string()
          .refine(
            value =>
              value
                .split(",")
                .every(prefix =>
                  /^https:\/\/[a-z0-9.-]+(?::\d+)?\/(?:[a-z0-9._~-]+\/)*$/.test(
                    prefix.trim(),
                  ),
                ),
            "MCP_ACTION_LOG_RESOURCE_PREFIXES must be comma-separated https URL prefixes ending in /",
          ),
      ),
      // Declared alongside their primary owners so the cross-key check below
      // runs inside this schema without coupling to another owner's object.
      PUBSUB_CREDENTIALS: z.string().optional(),
      PUBSUB_PROJECT_ID: emptyStringAsUndefined(z.string().trim().min(1)),
      USE_DB_AUTHENTICATION: z.stringbool().optional(),
    })
    .superRefine((value, context) => {
      for (const error of getMcpActionLogConfigErrors(value)) {
        context.addIssue({
          code: "custom",
          path: [error.path],
          message: error.message,
        });
      }
    }),
);
