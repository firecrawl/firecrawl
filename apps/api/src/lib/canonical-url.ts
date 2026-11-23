export function normalizeUrl(url: string) {
  // Scheme and host are case-insensitive (RFC 3986 section 6.2.2.1) while the
  // path is not, so only those two components are folded to lower case. The
  // regex keeps matching case-sensitively spread "HTTPS://Host" spellings out
  // of the result, which previously survived both the scheme and "www." strips.
  const schemeMatch = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(url);
  if (schemeMatch) {
    url = schemeMatch[2].replace(/^www\./i, "").toLowerCase() + schemeMatch[3];
  } else {
    url = url.replace(/^www\./i, "");
  }
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
