import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverSkills } from "./skill-cards";
import { isFreeCatalogueSearch, isToolsOnlySearch } from "./alexandria";
import { exchangeRequest } from "../services/alexandria/client";

vi.mock("../services/alexandria/client", () => ({ exchangeRequest: vi.fn() }));
const request = vi.mocked(exchangeRequest);
const logger = { warn: vi.fn() } as any;

const official = {
  id: "official/search",
  name: "Search",
  description: "Find records",
  source: "official" as const,
  similarity: 0.82,
  body: "full skill text",
};
const provider = {
  id: "acme/brief",
  name: "Brief",
  description: "A provider skill",
  source: "provider" as const,
  provider: "acme",
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("maps a successful discover response onto short cards", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { query: "records", skills: [official, provider] },
  });

  const cards = await discoverSkills(
    { teamId: "team", query: "  records  ", timeoutMs: 9000 },
    logger,
  );

  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toEqual({
    teamId: "team",
    path: "/v1/discover/skill-cards?q=records&limit=3",
    timeoutMs: 3000,
    usOnly: false,
    zeroDataRetention: false,
  });
  expect(request.mock.calls[0][0]).not.toHaveProperty("body");
  expect(cards.succeeded).toBe(true);
  expect(cards.skills).toEqual([
    {
      id: "official/search",
      name: "Search",
      description: "Find records",
      source: "official",
      similarity: 0.82,
    },
    {
      id: "acme/brief",
      name: "Brief",
      description: "A provider skill",
      source: "provider",
      provider: "acme",
    },
  ]);
});

it("omits similarity and provider when the match did not include them", async () => {
  request.mockResolvedValue({
    status: 200,
    body: {
      query: "records",
      skills: [
        {
          id: "official/search",
          name: "Search",
          description: "Find records",
          source: "official",
          provider: null,
          similarity: null,
        },
      ],
    },
  });

  const cards = await discoverSkills(
    { teamId: "team", query: "records", timeoutMs: 1000 },
    logger,
  );

  expect(cards.succeeded).toBe(true);
  expect(cards.skills).toEqual([
    {
      id: "official/search",
      name: "Search",
      description: "Find records",
      source: "official",
    },
  ]);
  expect(cards.skills[0]).not.toHaveProperty("similarity");
  expect(cards.skills[0]).not.toHaveProperty("provider");
});

it("returns no cards when the body is not the skill-card envelope", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { skills: [{ name: "cohort" }] },
  });

  await expect(
    discoverSkills(
      { teamId: "team", query: "records", timeoutMs: 1000 },
      logger,
    ),
  ).resolves.toEqual({ skills: [], succeeded: false });
  expect(logger.warn).toHaveBeenCalled();
});

it("forwards usOnly so Exchange can hide non-US providers", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { query: "records", skills: [] },
  });

  const found = await discoverSkills(
    { teamId: "team", query: "records", timeoutMs: 1000, usOnly: true },
    logger,
  );

  expect(request.mock.calls[0][0]).toMatchObject({ usOnly: true });
  expect(found).toEqual({ skills: [], succeeded: true });
});

it("forwards zero data retention so Exchange can hide providers without it", async () => {
  request.mockResolvedValue({
    status: 200,
    body: { query: "records", skills: [] },
  });

  await discoverSkills(
    {
      teamId: "team",
      query: "records",
      timeoutMs: 1000,
      zeroDataRetention: true,
    },
    logger,
  );

  expect(request.mock.calls[0][0]).toMatchObject({ zeroDataRetention: true });
});

it("returns only the first three when Exchange sends more", async () => {
  const skills = [1, 2, 3, 4].map(n => ({
    id: `official/skill-${n}`,
    name: `Skill ${n}`,
    description: "A skill",
    source: "official" as const,
  }));
  request.mockResolvedValue({
    status: 200,
    body: { query: "records", skills },
  });

  const found = await discoverSkills(
    { teamId: "team", query: "records", timeoutMs: 1000 },
    logger,
  );

  expect(found.succeeded).toBe(true);
  expect(found.skills.map(skill => skill.id)).toEqual([
    "official/skill-1",
    "official/skill-2",
    "official/skill-3",
  ]);
});

it("drops invalid cards and keeps the valid ones", async () => {
  request.mockResolvedValue({
    status: 200,
    body: {
      query: "records",
      skills: [
        { id: "", name: "Missing", description: "no", source: "official" },
        official,
      ],
    },
  });

  const cards = await discoverSkills(
    { teamId: "team", query: "records", timeoutMs: 1000 },
    logger,
  );

  expect(cards.succeeded).toBe(true);
  expect(cards.skills).toHaveLength(1);
  expect(cards.skills[0].id).toBe("official/search");
  expect(logger.warn).toHaveBeenCalled();
});

it.each([400, 500])(
  "returns no cards when discover answers %s",
  async status => {
    request.mockResolvedValue({ status, body: { error: "nope" } });

    await expect(
      discoverSkills(
        { teamId: "team", query: "records", timeoutMs: 1000 },
        logger,
      ),
    ).resolves.toEqual({ skills: [], succeeded: false });
    expect(logger.warn).toHaveBeenCalled();
  },
);

it("returns no cards when the exchange call times out", async () => {
  request.mockRejectedValue(
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    }),
  );

  await expect(
    discoverSkills(
      { teamId: "team", query: "records", timeoutMs: 3000 },
      logger,
    ),
  ).resolves.toEqual({ skills: [], succeeded: false });
  expect(logger.warn).toHaveBeenCalled();
});

it("returns no cards for an empty or over-long query without calling exchange", async () => {
  await expect(
    discoverSkills({ teamId: "team", query: "   ", timeoutMs: 1000 }, logger),
  ).resolves.toEqual({ skills: [], succeeded: false });
  await expect(
    discoverSkills(
      { teamId: "team", query: "x".repeat(2001), timeoutMs: 1000 },
      logger,
    ),
  ).resolves.toEqual({ skills: [], succeeded: false });
  expect(request).not.toHaveBeenCalled();
});

describe("catalogue search billing gate", () => {
  it("treats skill cards as free catalogue search without making them tools-only", () => {
    expect(isFreeCatalogueSearch([{ type: "skills" }], undefined)).toBe(true);
    expect(isToolsOnlySearch([{ type: "skills" }], undefined)).toBe(false);
    expect(
      isFreeCatalogueSearch(["alexandria", { type: "skills" }], undefined),
    ).toBe(true);
    expect(
      isFreeCatalogueSearch([{ type: "web" }, { type: "skills" }], undefined),
    ).toBe(false);
    expect(isFreeCatalogueSearch(["skills"], [{ type: "developer" }])).toBe(
      false,
    );
    for (const alias of [
      "docs",
      "repo",
      "code",
      "devdex",
      "repo_search",
      "developer_index",
    ]) {
      expect(isFreeCatalogueSearch(["alexandria"], [alias])).toBe(false);
      expect(isFreeCatalogueSearch(["alexandria"], [{ type: alias }])).toBe(
        false,
      );
    }
    expect(isFreeCatalogueSearch(["alexandria"], [{ type: "gov" }])).toBe(
      false,
    );
    expect(isToolsOnlySearch(["alexandria"], undefined)).toBe(true);
  });
});
