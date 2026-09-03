import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  SEARCH_INDEX_LOOKUP_TOKEN: "resolver-secret" as string | undefined,
}));
vi.mock("../config", () => ({ config: mockConfig }));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn() },
}));
vi.mock("../search/highlights", () => ({
  resolveHighlightIndexObject: vi.fn(),
}));

import { logger } from "../lib/logger";
import { resolveHighlightIndexObject } from "../search/highlights";
import { registerIndexedHighlightObjectRoute } from "./indexed-highlight-objects";

function app() {
  const server = express();
  registerIndexedHighlightObjectRoute(server);
  return server;
}

const pages = [
  { id: "0", url: "https://example.com/a" },
  { id: "1", url: "https://example.com/b" },
  { id: "2", url: "https://example.com/c" },
];

afterEach(() => {
  vi.clearAllMocks();
  mockConfig.SEARCH_INDEX_LOOKUP_TOKEN = "resolver-secret";
});

describe("POST /internal/indexed-highlight-objects", () => {
  it("returns one ordered outcome per URL when siblings hit, miss, and fail", async () => {
    vi.mocked(resolveHighlightIndexObject)
      .mockResolvedValueOnce({ name: "018f1234.json", createdAt: null })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer resolver-secret")
      .set("X-Request-ID", "request-1")
      .send({ pages });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      pages: [
        { ...pages[0], outcome: "hit", indexObject: "018f1234.json" },
        { ...pages[1], outcome: "miss" },
        { ...pages[2], outcome: "error" },
      ],
    });
    expect(resolveHighlightIndexObject).toHaveBeenCalledTimes(3);
    expect(vi.mocked(resolveHighlightIndexObject).mock.calls).toEqual(
      pages.map(page => [page.url]),
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Indexed highlight lookup completed",
      expect.objectContaining({
        attempted: 3,
        hits: 1,
        misses: 1,
        errors: 1,
        requestId: "request-1",
      }),
    );
  });

  it("rejects bad authentication before looking up a URL", async () => {
    const response = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer wrong")
      .send({ pages: pages.slice(0, 1) });

    expect(response.status).toBe(401);
    expect(resolveHighlightIndexObject).not.toHaveBeenCalled();
  });

  it("fails closed when the service token is not configured", async () => {
    mockConfig.SEARCH_INDEX_LOOKUP_TOKEN = undefined;

    const response = await request(app())
      .post("/internal/indexed-highlight-objects")
      .send({ pages: pages.slice(0, 1) });

    expect(response.status).toBe(401);
    expect(resolveHighlightIndexObject).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and an oversized body without a lookup", async () => {
    const malformed = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer resolver-secret")
      .set("Content-Type", "application/json")
      .send('{"pages": [');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "Invalid request body" });

    // A schema-valid batch is at most 12 x 8 KiB, so the body limit is only
    // reachable with padding. The parser-specific message proves the 400 came
    // from the body limit and not from the strict schema.
    const oversized = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer resolver-secret")
      .send({ pages: pages.slice(0, 1), padding: "a".repeat(129 * 1024) });
    expect(oversized.status).toBe(400);
    expect(oversized.body).toEqual({ error: "Invalid request body" });
    expect(resolveHighlightIndexObject).not.toHaveBeenCalled();
  });

  it("rejects one URL over 8 KiB", async () => {
    const response = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer resolver-secret")
      .send({
        pages: [
          { id: "0", url: "https://example.com/" + "a".repeat(8 * 1024) },
        ],
      });

    expect(response.status).toBe(400);
    expect(resolveHighlightIndexObject).not.toHaveBeenCalled();
  });

  it.each([
    { pages: [...pages, ...pages, ...pages, ...pages, pages[0]] },
    { pages: [pages[0], pages[0]] },
    { pages: [{ id: "12", url: "https://example.com" }] },
    { pages: [{ id: "0", url: "ftp://example.com/file" }] },
  ])("rejects an invalid batch", async body => {
    const response = await request(app())
      .post("/internal/indexed-highlight-objects")
      .set("Authorization", "Bearer resolver-secret")
      .send(body);

    expect(response.status).toBe(400);
    expect(resolveHighlightIndexObject).not.toHaveBeenCalled();
  });
});
