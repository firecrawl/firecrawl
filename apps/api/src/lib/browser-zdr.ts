import type { RequestWithAuth } from "../controllers/v2/types";
import type { BrowserSessionRow } from "./browser-sessions";
import { HangarError } from "./hangar";
import { getScrapeZDR } from "./zdr-helpers";

export function browserZeroDataRetention(
  req: RequestWithAuth<any, any, any>,
  session?: BrowserSessionRow,
  inherited = false,
): boolean {
  const mode = getScrapeZDR(req.acuc?.flags);
  if (
    req.body?.zeroDataRetention === true &&
    mode === "disabled" &&
    !session?.zero_data_retention &&
    !inherited
  ) {
    throw new HangarError(
      403,
      "Zero Data Retention is not enabled for your team.",
    );
  }
  const enabled =
    mode === "forced" ||
    req.body?.zeroDataRetention === true ||
    inherited ||
    session?.zero_data_retention === true;
  // A running browser may already have recorded or saved customer content.
  if (enabled && session && !session.zero_data_retention) {
    throw new HangarError(409, "Create a new ZDR browser session to continue.");
  }
  return enabled;
}

export function checkBrowserZdrOptions(options: {
  zeroDataRetention?: boolean;
  recordSession?: boolean;
  profile?: unknown;
}) {
  if (options.zeroDataRetention && (options.recordSession || options.profile)) {
    throw new HangarError(
      400,
      "Recordings and saved profiles are not supported with Zero Data Retention.",
    );
  }
}
