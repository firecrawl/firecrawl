import { EngineScrapeResult } from "../engines/types";

type EngineResultFile = {
  name?: string;
  content: string;
};

export function attachEngineResultFile<T extends EngineScrapeResult>(
  result: T,
  file: EngineResultFile | null | undefined,
): T {
  if (!file?.content) {
    return result;
  }

  Object.defineProperty(result, "file", {
    value: file,
    enumerable: false,
    configurable: true,
  });

  return result;
}

export function getEngineResultFile(
  result: EngineScrapeResult,
): EngineResultFile | undefined {
  const file = (result as { file?: EngineResultFile }).file;
  return file?.content ? file : undefined;
}
