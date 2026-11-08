import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a user-supplied path against the directory the CLI was invoked from.
 * Taskfile changes cwd to apps/cli/scraper but exports the original PWD as
 * SCRAPER_INVOKE_CWD so file outputs land where the user expects.
 */
export function resolveUserPath(p: string): string {
  if (isAbsolute(p) || p === "-") return p;
  const env = process.env["SCRAPER_INVOKE_CWD"];
  const base = env && env.length > 0 ? env : process.cwd();
  return resolve(base, p);
}
