import type { ScrapeRequest } from "../client.js";
import { type Config, mergeProfiles, type Profile, resolveDomainOverride } from "../config.js";
import { createEnginePool, type EngineName } from "../engines/index.js";
import { getFormat } from "../formats/index.js";
import { ArgInput } from "../inputs/arg.js";
import { pickOutput } from "../outputs/index.js";

export interface ScrapeCmdOptions {
  url: string;
  config: Config;
  profileName: string;
  formatName: string;
  out: string | undefined;
  engineOverride: EngineName | undefined;
  cdpUrlOverride: string | undefined;
}

export function buildRequest(
  url: string,
  config: Config,
  profileName: string,
  apiFormats: string[],
): ScrapeRequest {
  const profile: Profile | undefined = config.profiles[profileName];
  const domainOverride = resolveDomainOverride(config, url);
  const merged = mergeProfiles(config.profiles["default"], profile, domainOverride);
  const fmts = merged.formats && merged.formats.length > 0 ? merged.formats : apiFormats;
  return {
    url,
    formats: fmts,
    onlyMainContent: merged.onlyMainContent,
    waitFor: merged.waitFor,
    includeTags: merged.includeTags,
    excludeTags: merged.excludeTags,
    headers: merged.headers,
    actions: merged.actions,
    timeout: merged.timeout,
  };
}

export function resolveEngine(
  url: string,
  config: Config,
  profileName: string,
  cliOverride: EngineName | undefined,
): EngineName {
  if (cliOverride) return cliOverride;
  const domainOverride = resolveDomainOverride(config, url);
  if (domainOverride?.engine) return domainOverride.engine;
  const profile = config.profiles[profileName];
  if (profile?.engine) return profile.engine;
  return "api";
}

export async function runScrape(opts: ScrapeCmdOptions): Promise<void> {
  const fmt = getFormat(opts.formatName);
  const pool = createEnginePool(opts.config, opts.cdpUrlOverride);
  const writer = await pickOutput(opts.out);
  await writer.open();
  try {
    const input = new ArgInput([opts.url]);
    for await (const url of input.read()) {
      const engineName = resolveEngine(url, opts.config, opts.profileName, opts.engineOverride);
      const engine = pool.get(engineName);
      const req = buildRequest(url, opts.config, opts.profileName, fmt.apiFormats);
      const data = await engine.scrape(req);
      const content = fmt.fromResponse(data);
      await writer.write(url, content, fmt.ext);
    }
  } finally {
    await writer.close();
    await pool.closeAll();
  }
}
