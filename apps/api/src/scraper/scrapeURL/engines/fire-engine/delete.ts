import { Logger } from "winston";

import { robustFetch } from "../../lib/fetch";
import { MockState } from "../../lib/mock";
import { fireEngineStagingURL, fireEngineURL } from "./scrape";

export async function fireEngineDelete(
  logger: Logger,
  jobId: string | undefined,
  mock: MockState | null,
  abort?: AbortSignal,
  production = true,
) {
  // jobId only supplied if we need to defer deletion
  if (!jobId) {
    logger.debug("Fire Engine job id not supplied, skipping delete");
    return;
  }

  await robustFetch({
    url: `${production ? fireEngineURL : fireEngineStagingURL}/scrape/${jobId}`,
    method: "DELETE",
    headers: {},
    logger: logger.child({ method: "fireEngineDelete/robustFetch", jobId }),
    mock,
    abort,
  });

  logger.debug("Deleted job from Fire Engine", { jobId });
}
