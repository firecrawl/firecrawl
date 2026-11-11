// Text normalisation shared by the scorer and the truth self-check.
// Must stay equivalent to norm() in corpus/gen_truth.py.
//
// Both the truth snippet and the engine's markdown go through norm(): markdown escapes are
// undone, images dropped, links reduced to their text, common inline HTML tags removed, then
// everything that is not a letter, digit or combining mark is deleted and the rest lowercased.
// Whitespace, emphasis markers, table pipes, list bullets, smart quotes and punctuation therefore
// never decide a match.

const MD_ESC = /\\([!-/:-@[-`{-~])/g;
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/g;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const URL_PART = `(?:<[^>]*>|(?:[^()\\s]|\\([^()\\s]*\\))*)(?:\\s+(?:"[^"]*"|'[^']*'))?`;
const MD_IMG = new RegExp(`!\\[[^\\[\\]]*\\]\\(${URL_PART}\\)`, 'g');
const MD_LINK = new RegExp(`\\[([^\\[\\]]*)\\]\\(${URL_PART}\\)`, 'g');
const MD_REFLINK = /\[([^[\]]+)\]\[[^[\]]*\]/g;
const MD_REFDEF = /^[ \t]*\[[^[\]]+\]:[ \t]+\S+.*$/gm;
const HTML_TAG = /<\/?(?:br|p|div|span|a|b|i|em|strong|u|s|del|ins|mark|small|sup|sub|code|pre|kbd|samp|var|img|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|ul|ol|li|dl|dt|dd|h[1-6]|hr|blockquote|details|summary|section|article|figure|figcaption|picture|source|abbr|cite|q|time|center|font|wbr|nav|header|footer|main|aside|button|label|input|iframe|video|audio)(?:\s[^<>]*)?\/?>/gi;
const FENCE_INFO = /^([ \t>]*(?:`{3,}|~{3,}))[^\n`]*$/gm;
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

function entity(m, s) {
  if (s[0] === '#') {
    const cp = s[1] === 'x' || s[1] === 'X' ? parseInt(s.slice(2), 16) : parseInt(s.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return ' '; }
  }
  return ENT[s] ?? m;
}

export function norm(input) {
  let s = String(input).normalize('NFKC');
  s = s.replace(MD_ESC, '$1');
  s = s.replace(ENTITY, entity);
  // A code fence's info string (```yaml) is markup, not page text.
  s = s.replace(FENCE_INFO, '$1');
  s = s.replace(MD_REFDEF, ' ');
  s = s.replace(MD_IMG, ' ');
  s = s.replace(MD_LINK, '$1');
  s = s.replace(MD_LINK, '$1');
  s = s.replace(MD_REFLINK, '$1');
  s = s.replace(HTML_TAG, ' ');
  return s.toLowerCase().replace(NOT_WORD, '');
}
