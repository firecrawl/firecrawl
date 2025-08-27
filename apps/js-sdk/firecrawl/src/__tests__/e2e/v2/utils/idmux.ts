export type IdmuxRequest = {
  name?: string;
  concurrency?: number;
  credits?: number;
  tokens?: number;
  teamId?: string;
  flags?: Record<string, unknown>;
};

export type Identity = {
  apiKey: string;
  teamId: string;
};

let cachedIdentity: Identity | null = null;

export function getApiUrl(): string {
  return process.env.TEST_URL ?? process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
}

export async function getIdentity(req: IdmuxRequest = {}): Promise<Identity> {
  if (cachedIdentity) return cachedIdentity;

  const idmuxUrl = process.env.IDMUX_URL;
  if (!idmuxUrl) {
    const fallback: Identity = {
      apiKey: process.env.TEST_API_KEY ?? process.env.FIRECRAWL_API_KEY ?? "",
      teamId: process.env.TEST_TEAM_ID ?? "",
    };
    cachedIdentity = fallback;
    return fallback;
  }

  const runNumberRaw = process.env.GITHUB_RUN_NUMBER;
  const runNumber = runNumberRaw ? Number(runNumberRaw) : 0;
  const body = {
    refName: process.env.GITHUB_REF_NAME ?? "local",
    runNumber: Number.isFinite(runNumber) ? runNumber : 0,
    concurrency: req.concurrency ?? 100,
    ...req,
  };

  const res = await fetch(`${idmuxUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`idmux request failed: ${res.status} ${text}`);
  }

  const identity = (await res.json()) as Identity;
  cachedIdentity = identity;
  return identity;
}

