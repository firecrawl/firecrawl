export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

// System prompt for inner askLlm calls (the cheap model the extractor calls
// at runtime).
export const ASK_LLM_SYSTEM = [
  "You are a text-processing function in a data pipeline.",
  "Return only the requested value: no preamble, no markdown.",
  "You may summarize, classify, translate, or reformat the supplied text,",
  "but stay grounded in it: never invent facts or do outside lookups.",
  'If a JSON schema is provided and the text lacks what you need, return null, "" or [] as allowed by the schema.',
  "If no schema is provided and the text lacks what you need, return an empty string.",
].join(" ");

// Phase 1: pick short verbatim snippets from the markdown that sit next to the
// data the extractor will need. Each snippet is later located in the raw HTML so
// we can hand the codegen model a tight window instead of the whole page.
const ANCHOR_PICKER_SYSTEM = `You are a planning step in a web-extraction pipeline. Given a page's markdown, a target JSON Schema, and a task, pick short text snippets from the markdown that sit next to the data the extractor will need to read.

Rules:
- Each snippet must appear VERBATIM in the markdown.
- Prefer short (5-80 char) distinctive phrases.
- Prefer stable labels, headings, column names, semantic section text, or nearby static text over sample-specific values.
- Use values as snippets only when they are the most distinctive way to locate the relevant region in the sample page.
- Pick one snippet near each field the schema asks for. For a list/array schema, pick 2-4 snippets that hit DIFFERENT items.
- Prefer coverage of distinct schema fields over multiple snippets for the same field.
- Return at most 12 snippets.
- Avoid generic phrases ("Home", "Menu", "Read more") and very long quotes.
- Skip fields whose data clearly is not on the page.

Return only JSON of the form {"snippets": ["...", "..."]} - no markdown fences, no commentary.`;

// Phase 2: write the reusable extractor. Kept generic on purpose - the sandbox
// (a browser-like DOM with no network) enforces the environment, so the prompt
// describes intent, not an inventory of available globals.
const EXTRACTOR_SYSTEM = `You write one reusable JavaScript function:

    async function extract(doc, askLlm) { ... }

- \`doc\` is a standard DOM Document: querySelector, querySelectorAll, document.evaluate, textContent, getAttribute, etc.
- \`askLlm(prompt)\` returns a string.
- \`askLlm(prompt, jsonSchema)\` returns a value of that schema shape. It may return null, so guard its result.

Return contract:
- Return only the function source, beginning with \`async function extract\`.
- The returned data must match the target JSON Schema exactly: required fields, correct types, and no extra keys.
- Every returned value must be read from the runtime DOM or from askLlm at runtime.
- Never return a literal value copied from the sample page. Literals are allowed only for selectors, attribute names, regexes, enum values, error messages, and returned object keys.
- Do not use network, storage, timers, randomness, browser navigation, mutation observers, external libraries, or DOM mutation.

Failure behavior:
- If a required container or required value is missing, throw an Error with a specific message.
- Return null, "", or [] only when the correct surrounding container was found and that specific optional value is genuinely absent.
- Never fabricate a schema-shaped fallback object after extraction fails.
- Do not use try/catch to swallow extraction errors. Let failures throw, or throw a clearer Error.
- Use one primary extraction strategy per value. Explicit branches for known page variants are okay; throw if none match.

Extraction strategy:
- Prefer specific structured sources: semantic DOM, labels, headings, tables, attributes, JSON scripts, inline state blobs, or nearby containers from the provided HTML snippets.
- Anchor values to specific elements when the page has meaningful structure.
- Broad page-text reads such as doc.body.innerText or doc.body.textContent are allowed only as the primary strategy when the page itself is raw JSON/plaintext, or when the requested value only exists in rendered body text.
- Regex over broad page text is allowed only when no more specific DOM container or structured source exists. Do not use broad regex as a fallback after a selector fails.
- If data is JSON in a specific element, JSON.parse that element's textContent and read fields directly.
- If the whole page is JSON/plaintext, parse or search the exact available body text.
- If JSON is surrounded by non-JSON text and there is no better container, extracting the JSON substring with regex is acceptable as the primary strategy.
- Never ask askLlm to parse JSON you can parse deterministically.
- For arrays/lists, first select the repeated item/container elements, then extract each field relative to that item. Do not query the whole document for per-item fields inside the loop.
- When a value is present, coerce it to the schema's type. Keep dates as displayed unless the task asks for a specific format.

Selectors:
- Prefer stable, meaningful anchors: labels, headings, semantic attributes, itemprop, role, data-*, table headers, and nearby static text.
- Avoid fragile position selectors such as :nth-child and long sibling chains.
- Prefer descendant combinators over child combinators (\`>\`), because unseen wrappers often break direct-child selectors.
- Read URLs from href/src attributes, not from link text.
- CSS selectors cannot match visible text directly. To match text, select candidate elements then filter in JS, e.g. \`[...doc.querySelectorAll("tr")].find(r => r.textContent.includes("Total"))\`.

askLlm:
- Use askLlm only for semantic transformations selectors cannot do: summarize, classify, translate, normalize, or disambiguate by meaning.
- Pass the DOM text needed for the answer. For a summary, pass the article body; not just a title or label.
- If a field has a fixed enum, include the allowed values in the askLlm prompt or schema.
- Prefer askLlm(prompt, jsonSchema) for structured fields, enums, booleans, numbers, arrays, and objects.
- Validate askLlm output before returning it. If invalid, return an allowed empty value for optional fields or throw for required fields.
- When calling askLlm once per list item, run the calls concurrently with Promise.all.

Good patterns:

Required labeled value:
const row = [...doc.querySelectorAll("tr")].find(r => r.textContent.includes("Balance"));
if (!row) throw new Error("Missing Balance row");
const text = row.querySelector("td:last-child")?.textContent?.trim();
if (!text) throw new Error("Missing Balance value");
const balance = Number(text.replace(/[^0-9.-]/g, ""));

List item scoping:
const cards = [...doc.querySelectorAll("[data-testid='product-card']")];
if (!cards.length) throw new Error("Missing product cards");
const products = cards.map(card => {
  const name = card.querySelector("h2")?.textContent?.trim();
  if (!name) throw new Error("Missing product name");
  const url = card.querySelector("a")?.getAttribute("href") ?? null;
  return { name, url };
});

Raw JSON/plaintext page:
const bodyText = doc.body.textContent?.trim() || "";
const jsonMatch = bodyText.match(/\\{[\\s\\S]*\\}/);
if (!jsonMatch) throw new Error("Missing JSON object in page text");
const data = JSON.parse(jsonMatch[0]);
// Read the requested schema fields from data here.
// Throw if a required field is missing or has the wrong type.

Return only the function source, beginning with \`async function extract\`.`;

export function buildAnchorPickerMessages(args: {
  userPrompt: string;
  schemaJson: string;
  markdownPreview: string;
}): ChatMessage[] {
  return [
    { role: "system", content: ANCHOR_PICKER_SYSTEM },
    {
      role: "user",
      content: `### Page markdown

${args.markdownPreview}

### Target JSON Schema

${args.schemaJson}

### Task

${args.userPrompt}

### Output

Return {"snippets": [...]} with short verbatim fragments from the markdown above.`,
    },
  ];
}

export function buildExtractorMessages(args: {
  userPrompt: string;
  schemaJson: string;
  markdownPreview: string;
  anchorHtml: string;
  rejectionFeedback?: string;
  previousCode?: string;
}): ChatMessage[] {
  // Bulky reference first, the task last - long-context models answer better
  // when the question follows the documents it refers to.
  const markdown = args.markdownPreview.trim()
    ? `### Page markdown (one sample page - the values shown are NOT your output)

${args.markdownPreview}

`
    : "";

  // When we have the prior extractor, ask for a minimal repair rather than a
  // cold rewrite: a page usually drifts in one selector, so the fix should keep
  // the field mappings and structure identical and touch only what broke.
  const fix = args.previousCode?.trim()
    ? `Here is that function:

\`\`\`js
${args.previousCode.trim()}
\`\`\`

Repair it if the existing structure is valid. If the previous function violates any hard invalid pattern, rewrite the violating section completely. Do not preserve try/catch, whole-page scanning, regex fishing, swallowed errors, or catch-all empty returns. Keep only the parts that comply with the system rules.`
    : `Write the function again, fixing the issue above.`;

  const retry = args.rejectionFeedback?.trim()
    ? `

### Your previous attempt was rejected

${args.rejectionFeedback}

${fix} Every value must still come from a runtime DOM read or askLlm, and the result must match the schema exactly.`
    : "";

  return [
    { role: "system", content: EXTRACTOR_SYSTEM },
    {
      role: "user",
      content: `${markdown}### HTML snippets around the target fields

${args.anchorHtml}

### Target JSON Schema

${args.schemaJson}

### Task

${args.userPrompt}${retry}`,
    },
  ];
}
