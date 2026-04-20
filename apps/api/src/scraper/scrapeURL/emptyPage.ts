export function hasNoExtractableText(html: string): boolean {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;

  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length === 0;
}
