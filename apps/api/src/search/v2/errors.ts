import type { ErrorCode } from "../../lib/error";

/** Every search provider failed, so the search has no answer to give. */
export class SearchProviderUnavailableError extends Error {
  readonly code: ErrorCode = "SEARCH_PROVIDER_UNAVAILABLE";
  readonly httpStatus = 503;

  constructor(options?: ErrorOptions) {
    super("Search is temporarily unavailable. Retry the request.", options);
  }
}
