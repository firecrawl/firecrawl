import { noLimits } from "../service/defaults";
import type { LimitsModule } from "../service/modules";
import { installedService } from "../service/service";

const defaultLimits = noLimits();

/** Returns the installed service's limits module, or `noLimits()` when no service is installed. */
export function currentLimits(): LimitsModule {
  return installedService()?.modules.limits ?? defaultLimits;
}
