import { TypeSafeClient } from "@typesafe-ai/sdk";
import { config } from "../config";

let client: TypeSafeClient | undefined;

/**
 * The shared TypeSafe (Jev) client, or null when no API key is configured.
 * Callers pass their own timeout and retry policy per call.
 */
export function getTypeSafeClient(): TypeSafeClient | null {
  if (!config.TYPESAFE_API_KEY) return null;
  client ??= new TypeSafeClient({
    apiKey: config.TYPESAFE_API_KEY,
    logLevel: "off",
  });
  return client;
}
