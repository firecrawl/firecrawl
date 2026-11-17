import { isIP } from "node:net";

type Caller = {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  auth?: { hostedMcp?: boolean };
};

/**
 * The caller IP Alexandria's country checks read. The hosted MCP reaches the API
 * on an internal address, so it forwards the end user's IP in
 * x-firecrawl-client-ip. The header counts only on a call the hosted MCP proved
 * it made (auth.hostedMcp: its proxy secret or a delegated credential) and is
 * ignored from anyone else.
 */
export function alexandriaClientIp(req: Caller): string | undefined {
  const header = req.headers["x-firecrawl-client-ip"];
  const forwarded = typeof header === "string" ? header.trim() : undefined;
  return req.auth?.hostedMcp === true && forwarded && isIP(forwarded)
    ? forwarded
    : req.ip;
}
