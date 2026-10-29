interface ExtractorEntry {
  code: string;
  createdAt: number;
}

interface Entry {
  response: string;
  createdAt: number;
}

interface ExtractorMeta {
  url: string;
  model: string;
  cacheVersion: number;
}

export interface CacheBackend {
  getExtractor(key: string): Promise<ExtractorEntry | undefined>;
  setExtractor(key: string, code: string, meta: ExtractorMeta): Promise<void>;
  getLlm(key: string): Promise<Entry | undefined>;
  setLlm(key: string, response: string): Promise<void>;
  touch?(key: string): Promise<void>;
}
