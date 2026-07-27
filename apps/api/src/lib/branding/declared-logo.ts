/**
 * Fallback logo from site-declared brand marks, used only when the normal
 * candidate → heuristic → LLM pipeline produced no logo. JSON-LD `logo` is
 * the site explicitly naming its logo; the largest apple-touch icon is a
 * square brand mark by platform convention.
 */
export function pickDeclaredLogo(
  images: Array<{ type: string; src: string }> | undefined,
): { src: string; source: "logo-jsonld" | "apple-touch-icon" } | null {
  if (!images) return null;
  const jsonld = images.find(i => i.type === "logo-jsonld" && i.src);
  if (jsonld) return { src: jsonld.src, source: "logo-jsonld" };
  const touch = images.find(i => i.type === "apple-touch-icon" && i.src);
  if (touch) return { src: touch.src, source: "apple-touch-icon" };
  return null;
}
