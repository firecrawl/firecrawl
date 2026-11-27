import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "winston";
import { z } from "zod";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";

const saveMocksDirPath = path.join(__dirname, "../mocks/").replace("dist/", "");
const loadMocksDirPath = path
  .join(__dirname, "../../../__tests__/snips/mocks")
  .replace("dist/", "");

export async function saveMock(options: unknown, result: unknown) {
  if (config.FIRECRAWL_SAVE_MOCKS !== true) {
    return;
  }

  await mkdir(saveMocksDirPath, { recursive: true });

  const fileName = Date.now() + "-" + crypto.randomUUID() + ".json";
  const filePath = path.join(saveMocksDirPath, fileName);
  _logger.debug("Saved mock file", {
    filePath,
    module: "scrapeURL:mock",
    method: "saveMock",
  });

  await writeFile(
    filePath,
    JSON.stringify(
      {
        time: Date.now(),
        options,
        result,
      },
      undefined,
      4,
    ),
  );
}

const mockRequestSchema = z.object({
  time: z.number(),
  options: z.object({
    url: z.string(),
    method: z.string(),
    body: z.unknown().optional(),
    ignoreResponse: z.boolean().optional(),
    ignoreFailure: z.boolean().optional(),
    tryCount: z.number().optional(),
    tryCooldown: z.number().optional(),
  }),
  result: z.object({
    url: z.string().optional(),
    body: z.string(),
    status: z.number(),
    headers: z.union([
      z.array(z.tuple([z.string(), z.string()])),
      z.record(z.string(), z.string()),
    ]),
  }),
});

export type MockState = {
  requests: Array<z.infer<typeof mockRequestSchema>>;
  tracker: Record<string, number>;
};

export async function loadMock(
  name: string,
  logger: Logger = _logger,
): Promise<MockState | null> {
  try {
    const mockPath = path.join(loadMocksDirPath, name + ".json");

    const relative = path.relative(loadMocksDirPath, mockPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      // directory moving
      return null;
    }

    const raw: unknown = JSON.parse(await readFile(mockPath, "utf8"));
    const requests = mockRequestSchema.array().parse(raw);
    return {
      requests,
      tracker: {},
    };
  } catch (error: unknown) {
    logger.warn("Failed to load mock file!", {
      name,
      module: "scrapeURL:mock",
      method: "loadMock",
      error,
    });
    return null;
  }
}
