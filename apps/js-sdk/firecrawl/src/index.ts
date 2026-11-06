/**
 * Firecrawl JS/TS SDK, unified entrypoint.
 * - Exports: `Firecrawl` (default), `FirecrawlClient` (v2), and v2 types
 */

/** Direct v2 client. */
export { FirecrawlClient } from "./v2/client";
/** Public v2 request/response types. */
export * from "./v2/types";
/** Watcher class and options for crawl/batch job monitoring. */
export { Watcher, type WatcherOptions } from "./v2/watcher";
/** Collects Alexandria feedback tokens from call results for a session rating. */
export { collectFeedbackTokens } from "./v2/utils/feedbackTokens";
/** Research sub-client (accessed via `firecrawl.research`). */
export { ResearchClient } from "./v2/methods/research";

import { FirecrawlClient as V2 } from "./v2/client";

// Re-export v2 client options for convenience
export type { FirecrawlClientOptions, FirecrawlClientInput } from "./v2/client";

/** Unified client: the v2 client under the package's default export name. */
export class Firecrawl extends V2 {}

// Copy V2 method descriptors onto Firecrawl.prototype so that
// Object.getOwnPropertyNames(Object.getPrototypeOf(app)) includes them.
(function exposeV2MethodsOnTopLevel() {
  for (const name of Object.getOwnPropertyNames(V2.prototype)) {
    if (name === "constructor") continue;
    if (Object.prototype.hasOwnProperty.call(Firecrawl.prototype, name)) continue;
    const desc = Object.getOwnPropertyDescriptor(V2.prototype, name);
    if (desc) Object.defineProperty(Firecrawl.prototype, name, desc);
  }
})();

export default Firecrawl;
