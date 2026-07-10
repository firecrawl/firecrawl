import { randomUUID } from "crypto";

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: { ...actual.config, NUQ_FDB_READY_SHARDS: 2 },
  };
});

import { config } from "../../config";
import { NuQFdbQueue } from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

describeIf("NuQ FDB small ready-shard configurations", () => {
  test("READY_SHARDS < 4 never spins while probing an empty queue", async () => {
    const name = `t-small-shards-${randomUUID()}`;
    const queue = new NuQFdbQueue(name, { hasGroups: false });
    const id = randomUUID();
    await queue.addJob(
      id,
      { hello: "world" },
      { ownerId: randomUUID() },
      { teamLimit: null, queueCap: 100 },
    );

    const job = await queue.getJobToProcess();
    expect(job?.id).toBe(id);
    await queue.jobFinish(id, job!.lock!, null);
    await expect(queue.getJobToProcess()).resolves.toBeNull();

    const range = getFdb().tuple.range(["nuq", name]);
    await getNuqFdbDatabase().doTn(async tn =>
      tn.clearRange(range.begin as Buffer, range.end as Buffer),
    );
  });
});
