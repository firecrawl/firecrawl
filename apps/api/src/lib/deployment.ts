import { config } from "../config";
export function isSelfHosted(): boolean {
  return config.USE_DB_AUTHENTICATION !== true;
}

export function getErrorContactMessage(errorId?: string): string {
  if (isSelfHosted()) {
    return errorId
      ? `An error occurred. Please check your logs for more details. Error ID: ${errorId}`
      : "An error occurred. Please check your logs for more details.";
  } else {
    return errorId
      ? `An unexpected error occurred. Please contact help@firecrawl.com for help. Your exception ID is ${errorId}`
      : "An unexpected error occurred. Please contact help@firecrawl.com for help.";
  }
}
