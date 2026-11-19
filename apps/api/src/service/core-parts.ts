/*
 * The service's own extension, applied first in every service: its process
 * roles.
 *
 * A role's module is loaded when the role runs and not before, so a process
 * loads only the code of the role it runs. For the same reason this file
 * imports nothing at the top but types.
 */
import type { CoreParts, Worker } from "./service";

const role = (load: () => { start: Worker["run"] }): Worker => ({
  run: env => load().start(env),
});

const workers: Record<string, Worker> = {
  api: role(() => require("../index") as typeof import("../index")),
  "queue-worker": role(
    () =>
      require("../services/queue-worker") as typeof import("../services/queue-worker"),
  ),
  "extract-worker": role(
    () =>
      require("../services/extract-worker") as typeof import("../services/extract-worker"),
  ),
  "nuq-worker": role(
    () =>
      require("../services/worker/nuq-worker") as typeof import("../services/worker/nuq-worker"),
  ),
  "nuq-fdb-worker": role(
    () =>
      require("../services/worker/nuq-fdb-worker") as typeof import("../services/worker/nuq-fdb-worker"),
  ),
  "nuq-prefetch-worker": role(
    () =>
      require("../services/worker/nuq-prefetch-worker") as typeof import("../services/worker/nuq-prefetch-worker"),
  ),
  "nuq-reconciler-worker": role(
    () =>
      require("../services/worker/nuq-reconciler-worker") as typeof import("../services/worker/nuq-reconciler-worker"),
  ),
  "index-worker": role(
    () =>
      require("../services/indexing/index-worker") as typeof import("../services/indexing/index-worker"),
  ),
  "cclog-worker": role(
    () =>
      require("../services/cclog-worker") as typeof import("../services/cclog-worker"),
  ),
  "zdr-worker": role(
    () =>
      require("../services/zdr-worker") as typeof import("../services/zdr-worker"),
  ),
  harness: role(() => require("../harness") as typeof import("../harness")),
};

export function coreParts(): CoreParts {
  return {
    core: { name: "core", workers },
    logger: {
      error: (message, meta) => {
        (
          require("../lib/logger") as typeof import("../lib/logger")
        ).logger.error(message, meta);
      },
    },
  };
}
