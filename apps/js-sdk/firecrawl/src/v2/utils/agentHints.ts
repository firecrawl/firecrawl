/** Keep response guidance as metadata when convenience methods unwrap data. */
export function agentHintMetadata(body: unknown): { agent_hints?: string[] } {
  const hints = (body as { agent_hints?: unknown } | null)?.agent_hints;
  return Array.isArray(hints) && hints.every((hint) => typeof hint === "string")
    ? { agent_hints: [...hints] }
    : {};
}
