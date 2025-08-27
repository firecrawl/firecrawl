import CacheableLookup from 'cacheable-lookup';
import dns from 'dns';

export const cacheableLookup = (process.env.SENTRY_ENVIRONMENT === "dev" ? { lookup: dns.lookup, install: () => {} } : new CacheableLookup({}));
