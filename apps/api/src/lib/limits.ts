import { noLimits } from "../service/defaults";
import type { LimitsModule } from "../service/modules";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";

const defaultLimits = noLimits();

/** Returns the installed service's limits module, or `noLimits()` when no service is installed. */
export function currentLimits(): LimitsModule {
  return installedService()?.modules.limits ?? defaultLimits;
}

/** Resolves job scheduling priority via the active limits module, falling back to `base` on error. */
export async function resolveJobPriority(
  ctx: RequestContext,
  base: number,
  onError?: (error: unknown) => void,
): Promise<number> {
  try {
    return await currentLimits().jobPriority({ ctx, base });
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Preserve the base-priority fallback if error reporting fails.
    }
    return base;
  }
}
