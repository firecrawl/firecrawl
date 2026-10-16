import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./connection", () => ({
  db: { execute: vi.fn() },
  dbIndex: { execute: vi.fn() },
}));

import { authCreditUsageChunk } from "./rpc";

describe("auth credit usage database RPC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the exact bigint API-key ID alongside the legacy number", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          team_id: "00000000-0000-4000-8000-000000000001",
          api_key: "fc-test",
          api_key_id: "9007199254740993",
        },
      ],
    });

    const rows = await authCreditUsageChunk(
      { execute } as any,
      { key: "fc-test" },
      "hosted_mcp_oauth",
    );

    expect(rows[0].api_key_id_text).toBe("9007199254740993");
    expect(rows[0].api_key_id).toBe(Number("9007199254740993"));
    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain("auth_chunk_3(input_key => ");
    expect(query).toContain("hosted_mcp_oauth");
  });

  it("looks a key up by id through auth_chunk_3_from_key_id", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          team_id: "00000000-0000-4000-8000-000000000001",
          api_key_id: "42",
          oauth_grant_id: null,
        },
      ],
    });

    const rows = await authCreditUsageChunk({ execute } as any, { id: 42 });

    const query = JSON.stringify(execute.mock.calls[0][0]);
    expect(query).toContain("auth_chunk_3_from_key_id(input_key_id => ");
    expect(query).not.toContain("auth_chunk_3(");
    expect(rows[0].api_key_id).toBe(42);
    expect(rows[0].api_key_id_text).toBe("42");
  });
});
