import * as fs from "fs/promises";
import * as path from "path";
import { logger as _logger } from "../../../lib/logger";
import { Logger } from "winston";
const saveMocksDirPath = path.join(__dirname, "../mocks/").replace("dist/", "");
const loadMocksDirPath = path
  .join(__dirname, "../../../__tests__/snips/mocks")
  .replace("dist/", "");

export async function saveMock(options: unknown, result: unknown) {
  if (process.env.FIRECRAWL_SAVE_MOCKS !== "true") return;

  await fs.mkdir(saveMocksDirPath, { recursive: true });

  const fileName = Date.now() + "-" + crypto.randomUUID() + ".json";
  const filePath = path.join(saveMocksDirPath, fileName);
  console.log(filePath);

  await fs.writeFile(
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

export type MockState = {
  requests: {
    time: number;
    options: {
      url: string;
      method: string;
      body?: any;
      ignoreResponse: boolean;
      ignoreFailure: boolean;
      tryCount: number;
      tryCooldown?: number;
    };
    result: any;
  }[];
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

    const load = JSON.parse(await fs.readFile(mockPath, "utf8"));
    return {
      requests: load,
      tracker: {},
    };
  } catch (error) {
    logger.warn("Failed to load mock file!", {
      name,
      module: "scrapeURL:mock",
      method: "loadMock",
      error,
    });
    return null;
  }
}
