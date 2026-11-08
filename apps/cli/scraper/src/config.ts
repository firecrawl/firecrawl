import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const RetriesSchema = z.object({
  attempts: z.number().int().min(0).default(3),
  initialDelayMs: z.number().int().min(0).default(500),
});

const EngineNameSchema = z.enum(["api", "cdp"]);

const ProfileSchema = z
  .object({
    engine: EngineNameSchema.optional(),
    formats: z.array(z.string()).optional(),
    onlyMainContent: z.boolean().optional(),
    waitFor: z.number().int().min(0).optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    actions: z.array(z.unknown()).optional(),
    timeout: z.number().int().min(0).optional(),
  })
  .passthrough();

export type Profile = z.infer<typeof ProfileSchema>;

const ConfigSchema = z.object({
  apiUrl: z.string().url().default("http://localhost:3002"),
  concurrency: z.number().int().min(1).default(5),
  retries: RetriesSchema.default({ attempts: 3, initialDelayMs: 500 }),
  cdp: z
    .object({ url: z.string().url().default("http://localhost:9222") })
    .default({ url: "http://localhost:9222" }),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  domains: z.record(z.string(), ProfileSchema).default({}),
  transcribe: z
    .object({
      /** whisper.cpp `whisper-cli` binary; defaults to the in-app install location. */
      whisperBin: z.string().optional(),
      /** ggml model file; defaults to large-v3-turbo q5_0 in the install location. */
      model: z.string().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function interpolateEnv(raw: string): string {
  return raw.replace(ENV_RE, (_, name: string) => process.env[name] ?? "");
}

export async function loadConfig(path?: string): Promise<Config> {
  if (!path) return ConfigSchema.parse({});
  const abs = resolve(path);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return ConfigSchema.parse({});
    }
    throw err;
  }
  const interpolated = interpolateEnv(raw);
  const parsed: unknown = parseYaml(interpolated);
  const result = ConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${abs}:\n${issues}`);
  }
  return result.data;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function resolveDomainOverride(config: Config, url: string): Profile | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  for (const [pattern, override] of Object.entries(config.domains)) {
    if (pattern === host) return override;
    if (pattern.includes("*") && globToRegex(pattern).test(host)) return override;
  }
  return undefined;
}

export function mergeProfiles(...profiles: (Profile | undefined)[]): Profile {
  const out: Profile = {};
  for (const p of profiles) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (k === "headers" && typeof v === "object" && v !== null && !Array.isArray(v)) {
        out.headers = { ...out.headers, ...(v as Record<string, string>) };
      } else {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}
