// Controls every page has that aren't calls to action: skip links, map and
// image-viewer buttons. Kept narrow: "Search" or "Next" can be a site's real
// call to action.
const PAGE_CONTROL =
  /^(?:skip (?:to|navigation)|map$|satellite$|(?:enter |exit |toggle )?full ?screen$|view full ?size|zoom (?:in|out)$)/i;

export const isPageControl = (button: { text?: string }): boolean =>
  PAGE_CONTROL.test((button.text ?? "").trim());
