import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../llm/client", () => ({ pickSnippets: vi.fn() }));

import { pickSnippets } from "../llm/client";
import { buildAnchorContext } from "../pipeline/anchor";
import { parseDocument } from "./dom";

const html =
  '<section id="result"><p id="guide">Visit <a href="/guide"><em>our guide</em></a> for <b>more</b> details.</p><address>10 Main Street<br>London</address></section>';
const text = "Visit our guide for more details.";
const args = {
  html,
  markdownPreview: text,
  schemaJson: '{"type":"object"}',
  prompt: "Read the guide and address.",
};

beforeEach(() => vi.mocked(pickSnippets).mockReset());

it("keeps word boundaries in the actual anchored code-generation context", async () => {
  vi.mocked(pickSnippets).mockResolvedValue([text]);
  const context = await buildAnchorContext(args, {} as never);
  const doc = parseDocument(context);
  expect(context).toContain("VERIFIED SELECTORS");
  expect(context).toContain("#guide");
  expect(doc.querySelector("#guide")?.textContent).toBe(text);
  expect(doc.querySelector("address br")).not.toBeNull();
});

it("keeps the same boundaries in whole-page fallback context", async () => {
  vi.mocked(pickSnippets).mockResolvedValue([]);
  const doc = parseDocument(await buildAnchorContext(args, {} as never));
  expect(doc.querySelector("#guide")?.textContent).toBe(text);
  expect(doc.querySelector("address br")).not.toBeNull();
});
