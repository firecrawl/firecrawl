const { chInsertMock } = vi.hoisted(() => ({
  chInsertMock: vi.fn(),
}));

vi.mock("./clickhouse-client", () => ({
  chInsert: chInsertMock,
}));

vi.mock("../services/worker/nuq-router", () => ({
  fdbQueueEnabled: () => false,
}));

vi.mock("../services/worker/nuq-fdb", () => ({
  nuqFdbHealthCheck: vi.fn(),
  scrapeQueueFdb: {
    getTeamActiveCounts: vi.fn(),
  },
  withFdbTimeout: vi.fn(),
}));

import { runCclogTick } from "./cclog";

const minuteMs = 60 * 1000;

function sampleKey(at: Date): string {
  const minute = new Date(at);
  minute.setSeconds(0, 0);
  return `cclog:minute:${Math.floor(minute.getTime() / minuteMs)}`;
}

class FakeRedis {
  private hashes = new Map<string, Record<string, string>>();

  constructor(
    private readonly keys: string[],
    private readonly activeCounts: Record<string, number>,
  ) {}

  seedHash(key: string, values: Record<string, string>) {
    this.hashes.set(key, { ...values });
  }

  async scan() {
    return ["0", this.keys] as [string, string[]];
  }

  async zrangebyscore(key: string) {
    return Array.from({ length: this.activeCounts[key] ?? 0 }, (_, i) =>
      String(i),
    );
  }

  async hgetall(key: string) {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  pipeline() {
    return {
      hset: (
        key: string,
        valuesOrField: Record<string, string> | string,
        value?: string,
      ) => {
        const values =
          typeof valuesOrField === "string"
            ? { [valuesOrField]: value ?? "" }
            : valuesOrField;
        this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...values });
      },
      expire: () => {},
      exec: async () => [],
    };
  }
}

describe("cclog", () => {
  beforeEach(() => {
    chInsertMock.mockReset();
    chInsertMock.mockResolvedValue(true);
  });

  it("inserts avg and max aggregate concurrency rows into ClickHouse", async () => {
    const teamA = "11111111-1111-1111-1111-111111111111";
    const teamB = "22222222-2222-2222-2222-222222222222";
    const at = new Date("2026-06-26T12:20:15.000Z");
    const minute = new Date("2026-06-26T12:20:00.000Z");
    const redis = new FakeRedis(
      [`concurrency-limiter:${teamA}`, `concurrency-limiter:preview_${teamB}`],
      {
        [`concurrency-limiter:${teamA}`]: 7,
        [`concurrency-limiter:preview_${teamB}`]: 50,
      },
    );

    for (let i = 9; i >= 1; i--) {
      const sampleAt = new Date(minute.getTime() - i * minuteMs);
      redis.seedHash(sampleKey(sampleAt), {
        [teamA]: String(10 - i),
        ...(i === 9 ? { [teamB]: "10" } : {}),
      });
    }

    const result = await runCclogTick(redis as any, at);

    expect(result).toEqual({
      sampledTeams: 1,
      insertedRows: 2,
    });
    expect(chInsertMock).toHaveBeenCalledWith(
      "concurrency_logs",
      expect.arrayContaining([
        {
          team_id: teamA,
          avg_concurrency: 5,
          max_concurrency: 9,
          created_at: "2026-06-26T12:20:00.000Z",
        },
        {
          team_id: teamB,
          avg_concurrency: 1,
          max_concurrency: 10,
          created_at: "2026-06-26T12:20:00.000Z",
        },
      ]),
      { throwOnError: true },
    );
  });

  it("does not report inserted rows when the ClickHouse insert fails", async () => {
    const teamId = "11111111-1111-1111-1111-111111111111";
    const at = new Date("2026-06-26T12:20:00.000Z");
    const redis = new FakeRedis([], {});

    redis.seedHash(sampleKey(new Date("2026-06-26T12:19:00.000Z")), {
      [teamId]: "4",
    });
    chInsertMock.mockRejectedValueOnce(new Error("clickhouse unavailable"));

    const result = await runCclogTick(redis as any, at);

    expect(chInsertMock).toHaveBeenCalledWith(
      "concurrency_logs",
      [
        {
          team_id: teamId,
          avg_concurrency: 0,
          max_concurrency: 4,
          created_at: "2026-06-26T12:20:00.000Z",
        },
      ],
      { throwOnError: true },
    );
    expect(result.insertedRows).toBe(0);
  });

  it("does not report inserted rows when ClickHouse is not configured", async () => {
    const teamId = "11111111-1111-1111-1111-111111111111";
    const at = new Date("2026-06-26T12:20:00.000Z");
    const redis = new FakeRedis([], {});

    redis.seedHash(sampleKey(new Date("2026-06-26T12:19:00.000Z")), {
      [teamId]: "4",
    });
    chInsertMock.mockResolvedValueOnce(false);

    const result = await runCclogTick(redis as any, at);

    expect(chInsertMock).toHaveBeenCalledWith(
      "concurrency_logs",
      [
        {
          team_id: teamId,
          avg_concurrency: 0,
          max_concurrency: 4,
          created_at: "2026-06-26T12:20:00.000Z",
        },
      ],
      { throwOnError: true },
    );
    expect(result.insertedRows).toBe(0);
  });
});
