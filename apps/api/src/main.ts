/*
 * The entry point of every process: `node dist/src/main.js <role> [arguments]`.
 *
 * The role name is taken out of `process.argv`, so a role sees the same
 * arguments whichever file its process was started from.
 *
 * This file and what it imports load nothing with a side effect, so the first
 * code a process runs is still its role's own module.
 */
import { coreParts, createService, defaultModules, run } from "./service";

/** Builds the service and starts one of its process roles in this process. */
export function startRole(role: string): Promise<void> {
  return run(
    createService({ modules: defaultModules() }, coreParts()),
    role,
    __filename,
  );
}

if (require.main === module) {
  const [role = ""] = process.argv.splice(2, 1);
  void startRole(role);
}
