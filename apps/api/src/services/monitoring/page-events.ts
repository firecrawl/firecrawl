interface PageJudgmentForEvents {
  meaningful: boolean;
}

export function derivePageIsMeaningful(
  status: string,
  judgment: PageJudgmentForEvents | null,
): boolean | null {
  if (status !== "changed" || !judgment) return null;
  return judgment.meaningful;
}
