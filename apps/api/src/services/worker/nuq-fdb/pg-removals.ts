import type { Transaction } from "foundationdb";
import { getFdb, getNuqFdbDatabase } from "./client";
import { decodeJson, encodeJson } from "./keyspace";
import { NuqFdbMigrationStore } from "./migration-store";

export type DurablePgJobRemoval = {
  schemaVersion: 1;
  id: string;
  ownerId?: string;
  groupId?: string;
};

export class NuqFdbPgJobRemovalConflictError extends Error {
  constructor(jobId: string, reason: string) {
    super(`PG job removal conflict for ${jobId}: ${reason}`);
    this.name = "NuqFdbPgJobRemovalConflictError";
  }
}

function validateDescriptor(
  value: DurablePgJobRemoval | null,
  jobId: string,
): DurablePgJobRemoval | null {
  if (value === null) return null;
  if (
    value.schemaVersion !== 1 ||
    value.id !== jobId ||
    (value.ownerId !== undefined && typeof value.ownerId !== "string") ||
    (value.groupId !== undefined && typeof value.groupId !== "string")
  ) {
    throw new NuqFdbPgJobRemovalConflictError(jobId, "descriptor is corrupt");
  }
  return value;
}

// Durable cross-store deletion intent. The PG advisory lock serializes this
// record with publication, while FDB keeps enough routing metadata to finish
// Redis cleanup after the PG row has disappeared.
export class NuqFdbPgJobRemovals {
  constructor(private readonly migrationStore: NuqFdbMigrationStore) {}

  private key(jobId: string): Buffer {
    return getFdb().tuple.pack([
      "nuq-migration",
      1,
      "pg-job-removal",
      jobId.toLowerCase(),
    ]) as Buffer;
  }

  public async inspect(jobId: string): Promise<DurablePgJobRemoval | null> {
    const stableId = jobId.toLowerCase();
    return await getNuqFdbDatabase().doTn(async tn =>
      validateDescriptor(
        decodeJson<DurablePgJobRemoval>(await tn.get(this.key(stableId))),
        stableId,
      ),
    );
  }

  public async hasInTxn(tn: Transaction, jobId: string): Promise<boolean> {
    return Boolean(await tn.get(this.key(jobId.toLowerCase())));
  }

  public async begin(descriptor: DurablePgJobRemoval): Promise<void> {
    const stableId = descriptor.id.toLowerCase();
    const stableDescriptor = { ...descriptor, id: stableId };
    await getNuqFdbDatabase().doTn(async tn => {
      const key = this.key(stableId);
      const existing = validateDescriptor(
        decodeJson<DurablePgJobRemoval>(await tn.get(key)),
        stableId,
      );
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(stableDescriptor)) {
          throw new NuqFdbPgJobRemovalConflictError(
            stableId,
            "descriptor differs",
          );
        }
        return;
      }
      const pin = await this.migrationStore.inspectPinInTxn(
        tn,
        "scrape_job",
        stableId,
      );
      if (!pin || pin.backend !== "pg" || pin.lifecycle === "terminal") {
        throw new NuqFdbPgJobRemovalConflictError(
          stableId,
          "live PG migration pin is missing",
        );
      }
      tn.set(key, encodeJson(stableDescriptor));
    });
  }

  // Called while PG holds the stable-ID advisory lock. A deletion intent that
  // committed before this lock was acquired fences publication; rechecking the
  // pin also catches publishers prepared before deletion terminalized it.
  public async assertPublishable(jobIds: readonly string[]): Promise<void> {
    await getNuqFdbDatabase().doTn(async tn => {
      for (const jobId of jobIds) {
        const stableId = jobId.toLowerCase();
        if (await tn.get(this.key(stableId))) {
          throw new NuqFdbPgJobRemovalConflictError(
            stableId,
            "deletion is in progress",
          );
        }
        const pin = await this.migrationStore.inspectPinInTxn(
          tn,
          "scrape_job",
          stableId,
        );
        // Legacy/direct PG callers have no migration pin and remain valid.
        if (!pin) continue;
        if (pin.backend !== "pg" || pin.lifecycle === "terminal") {
          throw new NuqFdbPgJobRemovalConflictError(
            stableId,
            "migration pin is not publishable",
          );
        }
      }
    });
  }

  public async complete(jobId: string): Promise<void> {
    const stableId = jobId.toLowerCase();
    await getNuqFdbDatabase().doTn(async tn => {
      const pin = await this.migrationStore.inspectPinInTxn(
        tn,
        "scrape_job",
        stableId,
      );
      if (!pin || pin.lifecycle !== "terminal") {
        throw new NuqFdbPgJobRemovalConflictError(
          stableId,
          "cannot clear intent without a terminal pin",
        );
      }
      tn.clear(this.key(stableId));
    });
  }
}
