import { config } from "../../../config";

const DEFAULT_REDIRECT_PATH = "/app/monitoring";

export function sanitizeRedirectPath(path?: string | null): string {
  if (!path || typeof path !== "string") return DEFAULT_REDIRECT_PATH;
  if (!path.startsWith("/")) return DEFAULT_REDIRECT_PATH;
  if (path.startsWith("//") || path.startsWith("/\\")) {
    return DEFAULT_REDIRECT_PATH;
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return DEFAULT_REDIRECT_PATH;

  try {
    const base = new URL(config.FIRECRAWL_DASHBOARD_URL);
    const resolved = new URL(path, base);
    if (resolved.origin !== base.origin) return DEFAULT_REDIRECT_PATH;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_REDIRECT_PATH;
  }
}
