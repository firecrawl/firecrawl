import { Counter, Histogram } from "prom-client";

export const indexLookupCounter = new Counter({
  name: "firecrawl_index_lookup_total",
  help: "Index URL->id lookups by outcome (cache layer vs DB vs miss)",
  labelNames: ["outcome"],
});

export const indexCacheReadDuration = new Histogram({
  name: "firecrawl_index_cache_read_duration_seconds",
  help: "Duration of index cache (Dragonfly) reads",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5],
});

export const indexCacheErrorCounter = new Counter({
  name: "firecrawl_index_cache_errors_total",
  help: "Index cache (Dragonfly) operation errors",
  labelNames: ["op"],
});
