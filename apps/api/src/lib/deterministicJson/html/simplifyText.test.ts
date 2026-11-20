import { describe, expect, it } from "vitest";
import { parseDocument } from "./dom";
import { simplifyHtml } from "./simplify";

const sample = (body: string) => parseDocument(simplifyHtml(body)).body;

describe("simplified HTML text boundaries", () => {
  it("preserves spaces beside inline formatting", () => {
    const body = sample('<p id="greeting">Hello <strong>world</strong> !</p>');
    expect(body.querySelector("#greeting")?.textContent).toBe("Hello world !");
  });

  it("preserves a whitespace-only node between inline elements", () => {
    const body = sample(
      '<p><span class="first">Ada</span> <span class="last">Lovelace</span></p>',
    );
    expect(body.querySelector("p")?.textContent).toBe("Ada Lovelace");
  });

  it("keeps whitespace when flattening a single-child wrapper", () => {
    const body = sample("<p>Hello<span> <b>world</b> </span>!</p>");
    expect(body.querySelector("p")?.textContent).toBe("Hello world !");
    expect(body.querySelector("p > span")).toBeNull();
  });

  it("retains explicit line breaks in address and multiline text", () => {
    const body = sample(
      "<address>10 Main Street<br>Suite 4<br>London</address>",
    );
    const address = body.querySelector("address")!;
    expect(address.querySelectorAll("br")).toHaveLength(2);
    expect(
      [...address.childNodes]
        .map(node => (node.nodeName === "BR" ? "\n" : node.textContent))
        .join(""),
    ).toBe("10 Main Street\nSuite 4\nLondon");
  });

  it("does not sample line breaks out of a longer address", () => {
    const lines = [
      "Recipient",
      "Building A",
      "Floor 4",
      "10 Main Street",
      "District",
      "London",
      "Postcode",
    ];
    const address = sample(
      `<address>${lines.join("<br>")}</address>`,
    ).querySelector("address")!;
    expect(address.querySelectorAll("br")).toHaveLength(lines.length - 1);
    expect(
      [...address.childNodes]
        .map(node => (node.nodeName === "BR" ? "\n" : node.textContent))
        .join(""),
    ).toBe(lines.join("\n"));
  });

  it("keeps meaningful boundaries through nested links and emphasis", () => {
    const body = sample(
      '<p>Visit <a href="/guide"><em>our guide</em></a> for <b>more</b> details.</p>',
    );
    expect(body.querySelector("p")?.textContent).toBe(
      "Visit our guide for more details.",
    );
    expect(body.querySelector("a")?.getAttribute("href")).toBe("/guide");
  });

  it("collapses runs of source whitespace to one space", () => {
    expect(
      sample("<p>alpha\t  \n beta</p>").querySelector("p")?.textContent,
    ).toBe("alpha beta");
  });

  it("does not insert spaces where inline source text has none", () => {
    expect(
      sample("<p>Fire<b>crawl</b>!</p>").querySelector("p")?.textContent,
    ).toBe("Firecrawl!");
  });

  it("continues dropping scripts, hidden content and comments", () => {
    const body = sample(
      "<p>A<!-- comment -->B<span hidden>secret</span><script>bad()</script><style>p{color:red}</style></p>",
    );
    expect(body.querySelector("p")?.textContent).toBe("AB");
    expect(body.querySelector("script, style, [hidden]")).toBeNull();
  });

  it("still collapses repeated card structures and clips the sample budget", () => {
    const html =
      "<main>" +
      Array.from(
        { length: 50 },
        (_, i) =>
          `<article class="card"><h2>Item ${i}</h2><p>${"Detail ".repeat(20)}</p></article>`,
      ).join("") +
      "</main>";
    const simplified = simplifyHtml(html, {
      keepRepeats: 3,
      maxTotalLen: 1000,
    });
    expect(simplified.length).toBeLessThanOrEqual(1000);
    expect(
      parseDocument(simplified).querySelectorAll("article.card"),
    ).toHaveLength(3);
    expect(simplified).toContain("47 more <article> with the same shape");
  });
});
