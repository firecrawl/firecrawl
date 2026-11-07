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
  hsetCalls: Array<{ key: string; fields: number }> = [];
  execError: Error | null = null;

  constructor(
    private readonly keys: string[],
    private readonly activeCounts: Record<string, number>,
  ) {}

  seedHash(key: string, values: Record<string, string>) {
    this.hashes.set(key, { ...values });
  }

  getHash(key: string) {
    return this.hashes.get(key) ?? {};
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
    const self = this;
    let commands = 0;
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
        self.hsetCalls.push({ key, fields: Object.keys(values).length });
        self.hashes.set(key, { ...(self.hashes.get(key) ?? {}), ...values });
        commands++;
      },
      expire: () => {
        commands++;
      },
      exec: async (): Promise<[Error | null, unknown][]> =>
        Array.from({ length: commands }, (_, i) => [
          i === 0 ? self.execError : null,
          0,
        ]),
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

  it("saves samples with more teams than fit in a single HSET in chunks", async () => {
    // Dragonfly rejects commands with > 2^16 arguments, so a single HSET
    // breaks once a sample holds ~32k+ teams (production incident: aggregate
    // inserts silently logged rows=0 while samples never landed).
    const teamCount = 35491;
    const keys: string[] = [];
    const activeCounts: Record<string, number> = {};
    for (let i = 0; i < teamCount; i++) {
      const key = `concurrency-limiter:team-${i}`;
      keys.push(key);
      activeCounts[key] = 1;
    }

    const at = new Date("2026-06-26T12:20:15.000Z");
    const redis = new FakeRedis(keys, activeCounts);

    const result = await runCclogTick(redis as any, at);

    expect(result.sampledTeams).toBe(teamCount);

    const saved = redis.getHash(
      sampleKey(new Date("2026-06-26T12:20:00.000Z")),
    );
    expect(Object.keys(saved)).toHaveLength(teamCount);

    const sampleHsets = redis.hsetCalls.filter(
      x => x.key === sampleKey(new Date("2026-06-26T12:20:00.000Z")),
    );
    expect(sampleHsets.length).toBeGreaterThan(1);
    for (const call of sampleHsets) {
      // 2 args (HSET + key) + 2 per field must stay under 2^16
      expect(2 + call.fields * 2).toBeLessThanOrEqual(2 ** 16);
    }
  });

  it("fails loudly when the sample save pipeline errors", async () => {
    const at = new Date("2026-06-26T12:21:15.000Z");
    const redis = new FakeRedis(["concurrency-limiter:team-a"], {
      "concurrency-limiter:team-a": 3,
    });
    redis.execError = new Error("ERR Protocol error: invalid multibulk length");

    await expect(runCclogTick(redis as any, at)).rejects.toThrow(
      "Failed to save cclog minute sample",
    );
    expect(chInsertMock).not.toHaveBeenCalled();
  });
});
