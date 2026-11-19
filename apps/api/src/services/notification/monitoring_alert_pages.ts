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

// Notifications load the first 100 check pages, ordered by creation time, while
// `changed_count` covers the whole check. A noise total from that window is the
// check total only when every changed page is in the window.
export function noiseOmittedFromAlertPages(
  monitor: { judge_enabled?: boolean | null; goal?: string | null },
  check: { changed_count?: number | null },
  pages: AlertPageLike[],
): { noiseOmitted: number; hidePartialNoiseCount: boolean } {
  if (!judgingFiltersAlertNoise(monitor)) {
    return { noiseOmitted: 0, hidePartialNoiseCount: false };
  }
  const removed = pages.filter(isExplicitChangedNoise).length;
  const changedSeen = pages.filter(page => page.status === "changed").length;
  const listComplete = changedSeen >= (check.changed_count ?? 0);
  if (!listComplete) {
    return { noiseOmitted: 0, hidePartialNoiseCount: removed > 0 };
  }
  return { noiseOmitted: removed, hidePartialNoiseCount: false };
}
