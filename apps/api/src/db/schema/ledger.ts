import {
  pgSchema,
  bigint,
  boolean,
  text,
  timestamp,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

const ledger = pgSchema("ledger");

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const bigintNum = (name: string) => bigint(name, { mode: "number" });

export const provider_definitions = ledger.table("provider_definitions", {
  id: bigintNum("id").notNull().generatedAlwaysAsIdentity(),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
  is_active: boolean("is_active").notNull().default(true),
  provider_id: bigintNum("provider_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  provider_definition_type_id: bigintNum(
    "provider_definition_type_id",
  ).notNull(),
});

export const tracks = ledger.table("tracks", {
  id: bigintNum("id").notNull().generatedAlwaysAsIdentity(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
  received_at: ts("received_at").notNull().defaultNow(),
  provider_definition_id: bigintNum("provider_definition_id").notNull(),
  uuid: uuid("uuid").notNull().defaultRandom(),
  data: jsonb("data").notNull().default({}),
});
