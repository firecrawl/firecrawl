export type NuQPgPublicationPlacement = "active" | "backlog";

export type NuQPgPublication = {
  id: string;
  ownerId: string;
  groupId?: string;
  placement: NuQPgPublicationPlacement;
};

export type NuQPgPublicationOutcome = "published" | "promoted" | "compensated";

/**
 * Boundary for the durable generation intent which must surround PG + Redis
 * publication during the queue migration. The router integration will replace
 * this no-op adapter with generation-aware prepare/complete operations. Keep
 * this module PG-only: it must remain importable without native FDB bindings.
 */
export interface NuQPgPublicationAdapter {
  prepare(publications: readonly NuQPgPublication[]): Promise<void>;
  validateUnderPublicationLock(jobIds: readonly string[]): Promise<void>;
  complete(
    publications: readonly NuQPgPublication[],
    outcome: NuQPgPublicationOutcome,
  ): Promise<void>;
  retire(
    kind: "scrape_job" | "crawl_finished",
    objectId: string,
  ): Promise<void>;
}

export class NuQPgPublicationAdapterUnavailableError extends Error {
  public readonly code = "NUQ_PG_PUBLICATION_ADAPTER_UNAVAILABLE";
  public readonly retryable = true;

  constructor() {
    super(
      "NUQ_PG_PUBLICATION_ADAPTER_UNAVAILABLE: durable PG publication adapter is not registered",
    );
    this.name = this.constructor.name;
  }
}

const failClosedAdapter: NuQPgPublicationAdapter = {
  async prepare() {
    throw new NuQPgPublicationAdapterUnavailableError();
  },
  async validateUnderPublicationLock() {
    throw new NuQPgPublicationAdapterUnavailableError();
  },
  async complete() {
    throw new NuQPgPublicationAdapterUnavailableError();
  },
  async retire() {
    throw new NuQPgPublicationAdapterUnavailableError();
  },
};

export const passthroughNuQPgPublicationAdapter: NuQPgPublicationAdapter = {
  async prepare() {},
  async validateUnderPublicationLock() {},
  async complete() {},
  async retire() {},
};

let adapter: NuQPgPublicationAdapter = passthroughNuQPgPublicationAdapter;

export type PreparedNuQPgPublication = {
  publications: readonly NuQPgPublication[];
  adapter: NuQPgPublicationAdapter;
};

export function setNuQPgPublicationAdapter(
  next: NuQPgPublicationAdapter | null,
): void {
  adapter = next ?? failClosedAdapter;
}

export async function validateNuQPgPublicationUnderLock(
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length > 0) await adapter.validateUnderPublicationLock(jobIds);
}

export async function prepareNuQPgPublication(
  publications: readonly NuQPgPublication[],
): Promise<PreparedNuQPgPublication> {
  const prepared = { publications, adapter };
  if (publications.length > 0) await prepared.adapter.prepare(publications);
  return prepared;
}

export async function completePreparedNuQPgPublication(
  prepared: PreparedNuQPgPublication,
  outcome: NuQPgPublicationOutcome = "published",
): Promise<void> {
  await completePreparedNuQPgPublicationSubset(
    prepared,
    prepared.publications,
    outcome,
  );
}

export async function completePreparedNuQPgPublicationSubset(
  prepared: PreparedNuQPgPublication,
  publications: readonly NuQPgPublication[],
  outcome: NuQPgPublicationOutcome,
): Promise<void> {
  if (publications.length > 0) {
    await prepared.adapter.complete(publications, outcome);
  }
}

export async function retireNuQPgObject(
  kind: "scrape_job" | "crawl_finished",
  objectId: string,
): Promise<void> {
  await adapter.retire(kind, objectId);
}

export async function completeNuQPgPublication(
  publications: readonly NuQPgPublication[],
  outcome: NuQPgPublicationOutcome = "published",
): Promise<void> {
  if (publications.length > 0) await adapter.complete(publications, outcome);
}
