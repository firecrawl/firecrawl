import { Client } from "../client.js";
import type { Config } from "../config.js";
import { ApiEngine } from "./api.js";
import { CdpEngine, type CdpEngineOptions } from "./cdp.js";
import type { Engine, EngineName } from "./types.js";

export interface EnginePool {
  get(name: EngineName): Engine;
  closeAll(): Promise<void>;
}

export function createEnginePool(
  config: Config,
  cdpUrlOverride: string | undefined,
  cdpOptions: CdpEngineOptions = {},
): EnginePool {
  const cache = new Map<EngineName, Engine>();
  const cdpUrl = cdpUrlOverride ?? config.cdp?.url ?? "http://localhost:9222";

  return {
    get(name: EngineName): Engine {
      const existing = cache.get(name);
      if (existing) return existing;
      const engine: Engine =
        name === "cdp"
          ? new CdpEngine(cdpUrl, cdpOptions)
          : new ApiEngine(new Client({ apiUrl: config.apiUrl, retries: config.retries }));
      cache.set(name, engine);
      return engine;
    },
    async closeAll(): Promise<void> {
      for (const e of cache.values()) {
        if (e.close) await e.close();
      }
      cache.clear();
    },
  };
}

export type { Engine, EngineName } from "./types.js";
