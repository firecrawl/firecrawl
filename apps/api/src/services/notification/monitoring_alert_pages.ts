// Human-facing Slack and email alerts share this gate with the all-noise
// suppression check: judging must be on and the monitor must have a goal.
// Webhook payloads and in-app summaries keep the full page set.

type AlertPageJudgment = {
  meaningful: boolean;
} | null;

type AlertPageLike = {
  status: string;
  judgment?: AlertPageJudgment;
};

function judgingFiltersAlertNoise(monitor: {
  judge_enabled?: boolean | null;
  goal?: string | null;
}): boolean {
  return Boolean(monitor.judge_enabled && monitor.goal);
}

// A changed page the judge explicitly called noise. Missing judgments stay:
// a failed judge must not hide a change. New, removed, and error rows are
// never noise-filtered, even if a judgment object is present.
function isExplicitChangedNoise(page: AlertPageLike): boolean {
  return page.status === "changed" && page.judgment?.meaningful === false;
}

export function humanFacingAlertPages<T extends AlertPageLike>(
  monitor: { judge_enabled?: boolean | null; goal?: string | null },
  pages: T[],
): T[] {
  if (!judgingFiltersAlertNoise(monitor)) return pages;
  return pages.filter(page => !isExplicitChangedNoise(page));
}

export function omittedNoiseCount(
  monitor: { judge_enabled?: boolean | null; goal?: string | null },
  pages: AlertPageLike[],
): number {
  if (!judgingFiltersAlertNoise(monitor)) return 0;
  return pages.filter(isExplicitChangedNoise).length;
}
