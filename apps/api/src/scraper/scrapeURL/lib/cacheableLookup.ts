import CacheableLookup from "cacheable-lookup";
import dns from "dns";

import { config } from "../../../config";
export const cacheableLookup =
  config.SENTRY_ENVIRONMENT === "dev"
    ? { lookup: dns.lookup, install: () => {} }
    : new CacheableLookup({});
