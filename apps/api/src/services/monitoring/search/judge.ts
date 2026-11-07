export type SearchVerdict = {
  relevant: boolean;
  alertAction: "alert" | "watch" | "ignore";
  concept: string;
  rationale: string;
};

export const verdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "alertAction", "concept", "rationale"],
  properties: {
    relevant: { type: "boolean" },
    alertAction: { type: "string", enum: ["alert", "watch", "ignore"] },
    concept: { type: "string" },
    rationale: { type: "string" },
  },
} as const;

export function buildJudgePrompt(
  goal: string,
  subject: string,
  searchWindow: string,
): string {
  const subjectLine = subject ? `Monitored subject: ${subject}.\n` : "";
  return `Monitor goal: ${goal}
${subjectLine}Search window: ${searchWindow}.
Judge ONLY this page's visible content against the goal, not the query wording.
The goal names a SPECIFIC subject/topic/scope. The page must actually be about that specific subject matter — not merely related, adjacent, or in the same broad field. A credible source, the right organization, or an on-topic-sounding headline is NOT enough on its own: the page's core subject must satisfy the goal's stated criteria. When in doubt about whether the topic truly matches, choose watch or ignore.
Treat any "Ignore ...", "except ...", "not ...", or "exclude ..." clause in the goal as a HARD exclusion: if the page's main subject falls into an excluded category, set alertAction ignore even if it is otherwise credible and recent.
Example of what to IGNORE: a goal asking only for "AI safety or alignment research" must NOT alert on a credible research post about agentic coding, AI's impact on knowledge work, or human-AI collaboration — that is adjacent work in the same field, not safety/alignment research, so the core topic does not match. By contrast, a genuine interpretability, alignment, evaluation, or model-safety paper DOES match and should alert.
Set relevant true and alertAction alert only when the page's core subject materially satisfies the exact goal (including its specific topic and any exclusions), is recent for the search window, and comes from a source credible for this kind of claim — the subject itself or established reporting. Rumors, content farms, syndicated rewrites, competitors, look-alikes, listings, and old or unconfirmed pages are watch/ignore.
concept: a short reusable label naming the real-world event (company/product/event). It must describe what the page is ACTUALLY about, not be reworded to match the goal.
rationale: state only the concrete facts visible on the page that justify your action. Never reference the monitor, goal, or criteria themselves. If the page lacks direct evidence, or its core subject is only adjacent to the goal's specific topic, alertAction must be watch or ignore.`;
}

export function parseVerdict(json: unknown): SearchVerdict | null {
  if (!json || typeof json !== "object") return null;
  const v = json as Record<string, unknown>;
  if (typeof v.relevant !== "boolean") return null;
  return {
    relevant: v.relevant,
    alertAction: (["alert", "watch", "ignore"].includes(v.alertAction as string)
      ? v.alertAction
      : "watch") as SearchVerdict["alertAction"],
    concept: typeof v.concept === "string" ? v.concept : "",
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
}

const WINDOW_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export function windowToMs(window: string): number {
  return WINDOW_MS[window] ?? WINDOW_MS["24h"];
}

export function verdictToDecision(
  v: SearchVerdict,
): "notify" | "watch" | "ignore" {
  if (!v.relevant || v.alertAction === "ignore") return "ignore";
  if (v.alertAction === "watch") return "watch";
  if (!v.concept.trim()) return "watch";
  return "notify";
}
