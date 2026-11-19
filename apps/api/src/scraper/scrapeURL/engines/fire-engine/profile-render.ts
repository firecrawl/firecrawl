/**
 * True when fire-engine would move this chrome-cdp job onto chrome-cdp-render,
 * which rejects saved profiles. Mirrors shouldRouteToChromeCdpRender: a
 * request-level forceNonRender opts out, otherwise a screenshot action or
 * blockMedia: false selects the render browser.
 */
export function profileWouldLeaveChromeCdp(input: {
  profile: boolean;
  actions: Array<{ type: string; _forceNonRender?: boolean }>;
  blockMediaFalse: boolean;
  forceNonRender: boolean;
}): boolean {
  if (!input.profile || input.forceNonRender) return false;
  const screenshot = input.actions.some(
    action => action.type === "screenshot" && action._forceNonRender !== true,
  );
  return screenshot || input.blockMediaFalse;
}
