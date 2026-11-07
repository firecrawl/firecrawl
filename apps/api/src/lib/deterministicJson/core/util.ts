import { createHash } from "node:crypto";
import { logger } from "../../logger";

export const log = (...args: unknown[]): void => {
  logger.debug(
    args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    { module: "deterministic-json" },
  );
};

export function sha(input: string, chars = 32): string {
  return createHash("sha256").update(input).digest("hex").slice(0, chars);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
