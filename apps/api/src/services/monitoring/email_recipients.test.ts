type QueryResult = { data: unknown; error: unknown };
type ChainOp = "select" | "insert" | "update" | "delete" | "unknown";
type ClientKind = "primary" | "rr";

type CallRecord = { client: ClientKind; op: ChainOp };

const fromPrimary = vi.fn();
const fromRR = vi.fn();
const calls: CallRecord[] = [];

// Each test queues responses in the order the code under test will execute
// queries. The fluent chain swallows any sequence of select/insert/update/
// eq/neq calls and resolves at .maybeSingle() / .single() with the next
// queued result. Tests stay explicit about query order without coupling to
// the precise method chain shape.
type QueuedResponse = (client: ClientKind, op: ChainOp) => Promise<QueryResult>;
let queue: QueuedResponse[] = [];

function queueResponses(responses: QueuedResponse[]): void {
  queue = [...responses];
}

function makeChain(client: ClientKind): any {
  let op: ChainOp | null = null;
  const setOp = (next: ChainOp) => {
    if (op === null) op = next;
  };
  // Drizzle returns row arrays and throws on error; convert the queued
  // {data, error} responses accordingly.
  const resolve = (): Promise<unknown[]> => {
    const finalOp = op ?? "unknown";
    calls.push({ client, op: finalOp });
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `No queued response for client=${client} op=${finalOp} (queue exhausted)`,
      );
    }
    return next(client, finalOp).then(({ data, error }) => {
      if (error) return Promise.reject(error);
      return data === null || data === undefined ? [] : [data];
    });
  };
  const builder: any = {
    select: () => {
      setOp("select");
      return builder;
    },
    insert: () => {
      setOp("insert");
      return builder;
    },
    update: () => {
      setOp("update");
      return builder;
    },
    delete: () => {
      setOp("delete");
      return builder;
    },
    from: () => builder,
    values: () => builder,
    set: () => builder,
    where: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    orderBy: () => builder,
    limit: () => resolve(),
    returning: () => resolve(),
    then: (res: any, rej: any) => resolve().then(res, rej),
  };
  return builder;
}

vi.mock("../../db/connection", () => ({
  get db() {
    return makeChain("primary");
  },
  get dbRr() {
    return makeChain("rr");
  },
}));

import {
  confirmRecipientByToken,
  ensureMonitorEmailRecipient,
  unsubscribeRecipientByToken,
} from "./email_recipients";

beforeEach(() => {
  queue = [];
  calls.length = 0;
  fromPrimary.mockReset();
  fromRR.mockReset();
  fromPrimary.mockImplementation(() => makeChain("primary"));
  fromRR.mockImplementation(() => makeChain("rr"));
});

function recipientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-1",
    monitor_id: "monitor-1",
    team_id: "team-1",
    email: "alerts@example.com",
    status: "pending",
    token: "tok-1",
    source: "opt_in",
    confirmation_sent_at: null,
    confirmed_at: null,
    unsubscribed_at: null,
    last_notified_at: null,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

const baseEnsureInput = {
  monitorId: "monitor-1",
  teamId: "team-1",
  input: {
    email: "alerts@example.com",
    source: "opt_in" as const,
    status: "pending" as const,
  },
};

const ok =
  (data: unknown): QueuedResponse =>
  () =>
    Promise.resolve({ data, error: null });
const fail =
  (error: unknown): QueuedResponse =>
  () =>
    Promise.resolve({ data: null, error });

describe("ensureMonitorEmailRecipient", () => {
  it("returns existing row when the recipient already exists (no insert)", async () => {
    const existing = recipientRow({ status: "confirmed", source: "team" });
    queueResponses([ok(existing)]);

    const result = await ensureMonitorEmailRecipient(baseEnsureInput);

    expect(result).toEqual({ row: existing, created: false });
    expect(queue.length).toBe(0);
  });

  it("inserts and returns created=true when no row exists", async () => {
    const inserted = recipientRow();
    queueResponses([ok(null), ok(inserted)]);

    const result = await ensureMonitorEmailRecipient(baseEnsureInput);

    expect(result).toEqual({ row: inserted, created: true });
  });

  it("treats a concurrent-insert unique violation as not-created (no throw)", async () => {
    const winnerRow = recipientRow({ id: "rec-winner" });
    queueResponses([
      ok(null),
      fail({ code: "23505", message: "duplicate key" }),
      ok(winnerRow),
    ]);

    const result = await ensureMonitorEmailRecipient(baseEnsureInput);

    expect(result).toEqual({ row: winnerRow, created: false });
    // The race-recovery re-fetch MUST hit the primary; the read replica may
    // not yet have the row the concurrent writer just committed.
    expect(calls.map(c => ({ client: c.client, op: c.op }))).toEqual([
      { client: "rr", op: "select" },
      { client: "primary", op: "insert" },
      { client: "primary", op: "select" },
    ]);
  });

  it("rethrows non-unique insert errors", async () => {
    queueResponses([
      ok(null),
      fail({ code: "42501", message: "permission denied" }),
    ]);

    await expect(ensureMonitorEmailRecipient(baseEnsureInput)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("rethrows unique violations when no winning row can be re-fetched", async () => {
    queueResponses([
      ok(null),
      fail({ code: "23505", message: "duplicate key" }),
      ok(null),
    ]);

    await expect(ensureMonitorEmailRecipient(baseEnsureInput)).rejects.toThrow(
      /duplicate key/,
    );
  });
});

describe("confirmRecipientByToken", () => {
  it("transitions pending → confirmed when no race", async () => {
    const pending = recipientRow({ status: "pending" });
    const confirmed = recipientRow({
      status: "confirmed",
      confirmed_at: "now",
    });
    queueResponses([ok(pending), ok(confirmed)]);

    const result = await confirmRecipientByToken("tok-1");

    expect(result).toEqual(confirmed);
  });

  it("returns the row unchanged when status is already confirmed (no UPDATE)", async () => {
    const confirmed = recipientRow({
      status: "confirmed",
      confirmed_at: "now",
    });
    queueResponses([ok(confirmed)]);

    const result = await confirmRecipientByToken("tok-1");

    expect(result).toEqual(confirmed);
  });

  it("returns the row unchanged when status is unsubscribed (no UPDATE)", async () => {
    const unsubscribed = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(unsubscribed)]);

    const result = await confirmRecipientByToken("tok-1");

    expect(result).toEqual(unsubscribed);
  });

  it("does NOT overwrite a racing unsubscribe — refetches and returns it", async () => {
    // SELECT sees pending, but between SELECT and our conditional UPDATE
    // another caller unsubscribed the row. The UPDATE WHERE status='pending'
    // affects 0 rows, and we re-fetch to discover the unsubscribed state.
    const pending = recipientRow({ status: "pending" });
    const unsubscribed = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(pending), ok(null), ok(unsubscribed)]);

    const result = await confirmRecipientByToken("tok-1");

    expect(result).toEqual(unsubscribed);
    expect(result?.status).toBe("unsubscribed");
    // The post-UPDATE re-fetch MUST hit primary so we don't get a stale
    // 'pending' from the read replica right after our conditional write.
    expect(calls[calls.length - 1]).toEqual({
      client: "primary",
      op: "select",
    });
  });
});

describe("unsubscribeRecipientByToken", () => {
  it("transitions pending → unsubscribed when no race", async () => {
    const pending = recipientRow({ status: "pending" });
    const unsubscribed = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(pending), ok(unsubscribed)]);

    const result = await unsubscribeRecipientByToken("tok-1");

    expect(result).toEqual(unsubscribed);
  });

  it("transitions confirmed → unsubscribed when no race", async () => {
    const confirmed = recipientRow({
      status: "confirmed",
      confirmed_at: "now",
    });
    const unsubscribed = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(confirmed), ok(unsubscribed)]);

    const result = await unsubscribeRecipientByToken("tok-1");

    expect(result).toEqual(unsubscribed);
  });

  it("returns the row unchanged when already unsubscribed (no UPDATE)", async () => {
    const unsubscribed = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(unsubscribed)]);

    const result = await unsubscribeRecipientByToken("tok-1");

    expect(result).toEqual(unsubscribed);
  });

  it("handles a racing unsubscribe by re-fetching the terminal state", async () => {
    // SELECT sees pending; concurrent caller unsubscribes; our conditional
    // UPDATE WHERE status != 'unsubscribed' affects 0 rows. Re-fetch
    // confirms the terminal state.
    const pending = recipientRow({ status: "pending" });
    const alreadyUnsub = recipientRow({
      status: "unsubscribed",
      unsubscribed_at: "now",
    });
    queueResponses([ok(pending), ok(null), ok(alreadyUnsub)]);

    const result = await unsubscribeRecipientByToken("tok-1");

    expect(result).toEqual(alreadyUnsub);
    expect(calls[calls.length - 1]).toEqual({
      client: "primary",
      op: "select",
    });
  });
});
