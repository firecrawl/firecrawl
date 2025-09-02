export function getAdjustedMaxDepth(
  url: string,
  maxCrawlDepth: number,
): number {
  const baseURLDepth = getURLDepth(url);
  const adjustedMaxDepth = maxCrawlDepth + baseURLDepth;
  return adjustedMaxDepth;
}

export function getURLDepth(url: string): number {
  const pathSplits = new URL(url).pathname
    .split("/")
    .filter(x => x !== "" && x !== "index.php" && x !== "index.html");
  return pathSplits.length;
}
