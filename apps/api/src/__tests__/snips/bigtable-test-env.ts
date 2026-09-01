// MUST be the first import in any test file that exercises the Bigtable
// change tracking store. ESM imports execute in order, and the config module
// parses process.env at import time, so defaulting these here (before config
// is imported transitively via the snips lib or the store) makes the store
// consider itself configured whenever the emulator is in play.
if (process.env.BIGTABLE_EMULATOR_HOST) {
  process.env.BIGTABLE_PROJECT_ID ||= "firecrawl-test";
  process.env.BIGTABLE_INSTANCE_ID ||= "firecrawl-test-instance";
}
