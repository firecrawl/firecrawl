import { config } from "../config";
import { logsMessages } from "../service/defaults";
import { installedService } from "../service/service";

const defaultMessages = logsMessages();

export function isSelfHosted(): boolean {
  return config.USE_DB_AUTHENTICATION !== true;
}

export function getErrorContactMessage(errorId?: string): string {
  return (installedService()?.modules.messages ?? defaultMessages).errorContact(
    errorId,
  );
}
