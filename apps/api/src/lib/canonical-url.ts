export function normalizeUrl(url: string) {
  url = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  return url;
}

export function normalizeUrlOnlyHostname(url: string) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch (error) {
    return url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }
}
