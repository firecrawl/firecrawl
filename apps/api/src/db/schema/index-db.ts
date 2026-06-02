import {
  pgTable,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// Tables in the separate index Postgres project (INDEX_DATABASE_URL).
// Hash columns are bytea in the DB; the code passes Postgres hex literal
// strings ("\\x..."), and Postgres infers the column type, so they are typed
// as text here to match the values flowing through the code.

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

const urlSplitHashes = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    `url_split_${i}_hash`,
    text(`url_split_${i}_hash`),
  ]),
);

const domainSplitHashes = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    `domain_splits_${i}_hash`,
    text(`domain_splits_${i}_hash`),
  ]),
);

export const index = pgTable("index", {
  id: text("id"),
  url: text("url"),
  url_hash: text("url_hash"),
  original_url: text("original_url"),
  resolved_url: text("resolved_url"),
  has_screenshot: boolean("has_screenshot"),
  has_screenshot_fullscreen: boolean("has_screenshot_fullscreen"),
  is_mobile: boolean("is_mobile"),
  block_ads: boolean("block_ads"),
  location_country: text("location_country"),
  location_languages: text("location_languages").array(),
  status: integer("status"),
  is_precrawl: boolean("is_precrawl"),
  is_stealth: boolean("is_stealth"),
  wait_time_ms: integer("wait_time_ms"),
  title: text("title"),
  description: text("description"),
  created_at: ts("created_at"),
  ...urlSplitHashes,
  ...domainSplitHashes,
});

export const engpicker_queue = pgTable("engpicker_queue", {
  id: bigint("id", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),
  domain_hash: text("domain_hash").notNull(),
  domain_level: integer("domain_level").notNull(),
  picked_up_at: ts("picked_up_at"),
  done: boolean("done").notNull().default(false),
  created_at: ts("created_at").notNull().defaultNow(),
});

export const engpicker_verdicts = pgTable("engpicker_verdicts", {
  id: bigint("id", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),
  domain_hash: text("domain_hash").notNull(),
  verdict: text("verdict").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});
