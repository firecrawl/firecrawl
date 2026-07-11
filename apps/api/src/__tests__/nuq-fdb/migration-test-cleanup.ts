import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";
import { encodeI64 } from "../../services/worker/nuq-fdb/keyspace";
import {
  MIGRATION_GC_PARTITIONS,
  type MigrationObjectKind,
} from "../../services/worker/nuq-fdb/migration-store";

const GC_CATEGORIES = new Set(["pin", "control", "generation"]);
const OBJECT_KIND_VALUES = [
  "scrape_job",
  "group",
  "external_holder",
  "crawl_finished",
  "sweeper_task",
  "cross_store_intent",
] as const satisfies readonly MigrationObjectKind[];
const OBJECT_KINDS: ReadonlySet<string> = new Set(OBJECT_KIND_VALUES);
const FENWICK_UPPER_BOUND = 1n << 53n;

/**
 * Removes migration-store records owned by the specified test teams without
 * disturbing records owned by concurrently running suites.
 *
 * Migration tombstones are absent from the active team-object index, and each
 * terminal pin/control operation/generation has a global GC index entry plus
 * partition-local Fenwick counters. Discovering and removing all of those
 * records in one transaction keeps the production accounting invariant exact.
 * GC cursors and leases are category/partition scheduler state, not team-owned;
 * retaining them is the only safe choice because another team's sweep may own
 * the same partition.
 */
export async function clearMigrationTestTeams(
  teamIds: Iterable<string>,
): Promise<void> {
  const selectedTeams = new Set(teamIds);
  if (selectedTeams.size === 0) return;

  const fdb = getFdb();
  const db = getNuqFdbDatabase();
  const objects = fdb.tuple.range(["nuq-migration", 1, "object"]);
  const gc = fdb.tuple.range(["nuq-migration", 1, "gc"]);

  await db.doTn(async tn => {
    // These are intentionally non-snapshot range reads. Concurrent migration
    // writers must conflict and retry cleanup rather than adding an index after
    // its canonical row was inspected.
    const [objectRows, gcRows] = await Promise.all([
      tn.getRangeAll(objects.begin as Buffer, objects.end as Buffer),
      tn.getRangeAll(gc.begin as Buffer, gc.end as Buffer),
    ]);
    const selectedObjects = new Set<string>();

    for (const [key, value] of objectRows) {
      const pin = JSON.parse((value as Buffer).toString()) as {
        teamId?: unknown;
        kind?: unknown;
        objectId?: unknown;
      };
      if (typeof pin.teamId !== "string" || !selectedTeams.has(pin.teamId)) {
        continue;
      }
      const parts = fdb.tuple.unpack(key as Buffer);
      const kind = String(parts[3]);
      const objectId = String(parts[4]);
      if (
        parts.length !== 5 ||
        !OBJECT_KINDS.has(kind) ||
        pin.kind !== kind ||
        pin.objectId !== objectId
      ) {
        throw new Error("invalid canonical pin in migration test cleanup");
      }
      selectedObjects.add(`${kind}\0${objectId}`);
      tn.clear(key as Buffer);
    }

    for (const [key] of gcRows) {
      const parts = fdb.tuple.unpack(key as Buffer);
      const category = String(parts[3]);
      if (!GC_CATEGORIES.has(category)) continue;

      const owned =
        category === "pin"
          ? selectedObjects.has(`${String(parts[6])}\0${String(parts[7])}`)
          : selectedTeams.has(String(parts[6]));
      if (!owned) continue;

      const partition = Number(parts[4]);
      const dueAt = Number(parts[5]);
      const expectedParts = category === "pin" ? 11 : 10;
      if (
        parts.length !== expectedParts ||
        !Number.isSafeInteger(partition) ||
        partition < 0 ||
        partition >= MIGRATION_GC_PARTITIONS ||
        !Number.isSafeInteger(dueAt) ||
        dueAt < 0
      ) {
        throw new Error(`invalid ${category} GC index in test cleanup`);
      }

      tn.clear(key as Buffer);
      let node = BigInt(dueAt) + 1n;
      while (node <= FENWICK_UPPER_BOUND) {
        tn.add(
          fdb.tuple.pack([
            "nuq-migration",
            1,
            "gc",
            "due-count",
            category,
            partition,
            node.toString(),
          ]),
          encodeI64(-1),
        );
        node += node & -node;
      }
    }

    for (const teamId of selectedTeams) {
      const team = fdb.tuple.range(["nuq-migration", 1, "team", teamId]);
      tn.clearRange(team.begin as Buffer, team.end as Buffer);
    }
  });
}
