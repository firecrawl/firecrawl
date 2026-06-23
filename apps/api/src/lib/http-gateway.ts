import { config } from "../config";

export function httpGatewayEnabled(): boolean {
  return !!config.FIRE_ENGINE_HTTP_GATEWAY_URL;
}

export async function httpGateway(
  url: string,
  opts: {
    headers?: Record<string, string>;
    /** `host:port[:user:pass]` */
    proxy?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  url: string;
  status: number;
  headers: Array<{ name: string; value: string }>;
  buffer: Buffer;
}> {
  const base = config.FIRE_ENGINE_HTTP_GATEWAY_URL;
  if (!base) throw new Error("http-gateway not configured");

  const res = await fetch(`${base.replace(/\/$/, "")}/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: "GET",
      headers: opts.headers ?? {},
      ...(opts.proxy ? { proxy: proxyToUrl(opts.proxy) } : {}),
    }),
    signal: opts.signal,
  });

  let finalUrl = url;
  const headers: Array<{ name: string; value: string }> = [];
  res.headers.forEach((value, name) => {
    if (name.toLowerCase() === "x-firecrawl-final-url") finalUrl = value;
    else headers.push({ name, value });
  });

  return {
    url: finalUrl,
    status: res.status,
    headers,
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

function proxyToUrl(p: string): string {
  const [host, port, user, pass] = p.split(":");
  return user && pass
    ? `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
    : `http://${host}:${port}`;
}
