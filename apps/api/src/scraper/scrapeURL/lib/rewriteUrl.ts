// Convenience URL rewrites, "fake redirects" in essence.
// Used to rewrite commonly used non-scrapable URLs to their scrapable equivalents.
export function rewriteUrl(url: string): string | undefined {
  if (
    url.startsWith("https://docs.google.com/document/d/") ||
    url.startsWith("http://docs.google.com/document/d/")
  ) {
    // Skip rewriting for published documents (/d/e/) - they're already public HTML pages
    if (url.includes("/document/d/e/")) {
      return undefined;
    }
    const id = url.match(/\/document\/d\/([-\w]+)/)?.[1];
    if (id) {
      return `https://docs.google.com/document/d/${id}/export?format=html`;
    }
  } else if (
    url.startsWith("https://docs.google.com/presentation/d/") ||
    url.startsWith("http://docs.google.com/presentation/d/")
  ) {
    // Skip rewriting for published presentations (/d/e/) - they are already public HTML pages
    if (url.includes("/presentation/d/e/")) {
      return undefined;
    }
    const id = url.match(/\/presentation\/d\/([-\w]+)/)?.[1];
    if (id) {
      return `https://docs.google.com/presentation/d/${id}/export?format=html`;
    }
  } else if (
    url.startsWith("https://drive.google.com/file/d/") ||
    url.startsWith("http://drive.google.com/file/d/")
  ) {
    const id = url.match(/\/file\/d\/([-\w]+)/)?.[1];
    if (id) {
      return `https://drive.google.com/uc?export=download&id=${id}`;
    }
  } else if (
    url.startsWith("https://docs.google.com/spreadsheets/d/") ||
    url.startsWith("http://docs.google.com/spreadsheets/d/")
  ) {
    // Skip rewriting for published spreadsheets (/d/e/) - they are already public HTML pages
    if (url.includes("/spreadsheets/d/e/")) {
      return undefined;
    }
    const id = url.match(/\/spreadsheets\/d\/([-\w]+)/)?.[1];
    if (id) {
      // Extract gid parameter from query string or hash fragment to preserve the selected tab
      const gidMatch = url.match(/[?&#]gid=(\d+)/);
      const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : "";
      return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:html${gidParam}`;
    }
  } else if (
    url.startsWith("https://github.com/") ||
    url.startsWith("http://github.com/")
  ) {
    // Rewrite blob (file) views to raw.githubusercontent.com — the blob page is a JS SPA,
    // raw serves the same content as plain text in milliseconds.
    // /tree/ (directories), /commit/, /pull/ etc. are left alone.
    const match = url.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^?#]+)/,
    );
    if (match) {
      const [, owner, repo, branchAndPath] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branchAndPath}`;
    }
  }

  return undefined;
}
