import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@mendable/firecrawl-rs", () => ({
  convertDocumentToMarkdown: vi.fn(async () => "converted document"),
}));
vi.mock("../utils/downloadFile", () => ({
  fetchFileToBuffer: vi.fn(),
  fetchFileGuardingProxyFailure: vi.fn(),
}));
vi.mock("../fire-engine/available", () => ({ useFireEngine: false }));
vi.mock("../pdf/markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

import { convertDocumentToMarkdown } from "@mendable/firecrawl-rs";
import { scrapeDocument } from "./index";
import { fetchFileToBuffer } from "../utils/downloadFile";

const directories: string[] = [];
const csv = Buffer.from("Name,Price\nItem,42\n");

async function metaFor(urlPath: string, contentType?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "document-extension-"));
  directories.push(directory);
  const filePath = path.join(directory, "prefetched-document");
  await writeFile(filePath, csv);
  const url = `https://example.com${urlPath}`;
  return {
    id: "document-test",
    url,
    options: {},
    internalOptions: {},
    featureFlags: new Set(["document"]),
    logger: { warn: vi.fn() },
    documentPrefetch: {
      filePath,
      url,
      contentType,
      status: 200,
      proxyUsed: "basic",
    },
  } as any;
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, { recursive: true, force: true })),
  );
});

describe("document extension hints", () => {
  it.each([
    "/archive.docx/report.csv",
    "/archive.xlsx/report.csv",
    "/archive.docx/report.csv/download",
  ])(
    "passes the filename's CSV hint to the converter for %s",
    async urlPath => {
      const meta = await metaFor(urlPath);
      const result = await scrapeDocument(meta);
      expect(convertDocumentToMarkdown).toHaveBeenCalledWith(
        new Uint8Array(csv),
        ".csv",
      );
      expect(result.contentType).toBe("text/csv");
      expect(result.url).toBe(meta.url);
      expect(fetchFileToBuffer).not.toHaveBeenCalled();
      await expect(stat(meta.documentPrefetch.filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("keeps an explicit supported media type ahead of URL hints", async () => {
    const meta = await metaFor(
      "/archive.docx/report.xlsx",
      "text/csv; charset=utf-8",
    );
    const result = await scrapeDocument(meta);
    expect(convertDocumentToMarkdown).toHaveBeenCalledWith(
      new Uint8Array(csv),
      ".csv",
    );
    expect(result.contentType).toBe("text/csv; charset=utf-8");
  });
});
