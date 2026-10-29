import {
  pgTable,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  bytea,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Tables in the separate index Postgres project (INDEX_DATABASE_URL).

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

const urlSplitHashes = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => {
    const col = bytea(`url_split_${i}_hash`);
    return [`url_split_${i}_hash`, i === 0 ? col.notNull() : col];
  }),
);

const domainSplitHashes = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    `domain_splits_${i}_hash`,
    bytea(`domain_splits_${i}_hash`),
  ]),
);

export const index = pgTable("index", {
  id: uuid("id").primaryKey().defaultRandom(),
  created_at: ts("created_at").notNull().defaultNow(),
  url: text("url").notNull(),
  url_hash: bytea("url_hash").notNull(),
  original_url: text("original_url").notNull(),
  resolved_url: text("resolved_url").notNull(),
  has_screenshot: boolean("has_screenshot").notNull(),
  has_screenshot_fullscreen: boolean("has_screenshot_fullscreen").notNull(),
  is_mobile: boolean("is_mobile").notNull(),
  block_ads: boolean("block_ads").notNull(),
  location_country: text("location_country"),
  location_languages: text("location_languages").array(),
  status: integer("status").notNull(),
  title: text("title"),
  description: text("description"),
  invalidated_at: ts("invalidated_at"),
  is_precrawl: boolean("is_precrawl"),
  wait_time_ms: bigint("wait_time_ms", { mode: "number" }),
  is_stealth: boolean("is_stealth").notNull().default(false),
  ...urlSplitHashes,
  ...domainSplitHashes,
});

export const engpicker_queue = pgTable("engpicker_queue", {
  id: bigint("id", { mode: "number" })
    .primaryKey()
    .generatedByDefaultAsIdentity(),
  domain_hash: bytea("domain_hash").notNull(),
  domain_level: integer("domain_level").notNull(),
  picked_up_at: ts("picked_up_at"),
  done: boolean("done").notNull().default(false),
  created_at: ts("created_at").notNull().defaultNow(),
});

export const engpicker_verdicts = pgTable("engpicker_verdicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain_hash: bytea("domain_hash").notNull(),
  verdict: varchar("verdict").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});
