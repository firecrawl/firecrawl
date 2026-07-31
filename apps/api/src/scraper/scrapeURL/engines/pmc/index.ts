/**
 * PMC official-source adapter.
 *
 * pmc.ncbi.nlm.nih.gov fronts its rendered HTML with a reCAPTCHA interstitial
 * that browser engines happily return as a 200, so scrapes "succeed" with
 * "Checking your browser - reCAPTCHA" as the document. NCBI publishes the same
 * articles as machine-readable BioC JSON, which needs no browser at all, so we
 * take that route first and only fall through to the normal waterfall when the
 * official source can't serve the article.
 */

import * as undici from "undici";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { config } from "../../../../config";
import { EngineError } from "../../error";
import { getSecureDispatcher } from "../utils/safeFetch";
import { pmcBiocCounter } from "../../../../lib/antibot-fallback-metrics";

const BIOC_ENDPOINT =
  "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json";

/** Hosts whose /articles/PMC…/ paths this adapter understands. */
const PMC_HOSTS = new Set([
  "pmc.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
]);

const PMCID_PATTERN = /^PMC\d{1,9}$/;

/**
 * Extracts the PMC identifier from a supported article URL, or null when the
 * URL isn't a PMC article we can serve from the official API.
 */
export function extractPmcId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!PMC_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  // pmc.ncbi.nlm.nih.gov/articles/PMC5968224/
  // www.ncbi.nlm.nih.gov/pmc/articles/PMC5968224/
  const match = parsed.pathname.match(
    /(?:^|\/)(?:pmc\/)?articles\/(PMC\d+)(?:\/|$)/i,
  );
  if (!match) return null;

  const pmcId = match[1].toUpperCase();
  if (!PMCID_PATTERN.test(pmcId)) return null;
  return pmcId;
}

export function isPmcArticleUrl(url: string): boolean {
  return extractPmcId(url) !== null;
}

type BiocPassage = {
  infons?: Record<string, string>;
  text?: string;
};

type BiocDocument = {
  id?: string;
  infons?: Record<string, string>;
  passages?: BiocPassage[];
};

type BiocCollection = {
  documents?: BiocDocument[];
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Reads at most `maxBytes` from the response body. Anything larger is a
 * malformed/hostile response as far as we're concerned — BioC articles are
 * a few hundred KB.
 */
async function readBounded(
  response: undici.Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new EngineError(
        `PMC BioC response exceeded ${maxBytes} bytes; refusing to buffer`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `surname:Han;given-names:Kyung (Chris) Tyek` -> `Kyung (Chris) Tyek Han` */
function formatAuthor(raw: string): string | null {
  const parts = Object.fromEntries(
    raw
      .split(";")
      .map(pair => {
        const idx = pair.indexOf(":");
        return idx === -1
          ? null
          : ([pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()] as const);
      })
      .filter((x): x is readonly [string, string] => x !== null),
  );
  const given = parts["given-names"] ?? "";
  const surname = parts["surname"] ?? "";
  const name = `${given} ${surname}`.trim();
  return name.length > 0 ? name : null;
}

/**
 * Heading level for a BioC passage type. `title_1` is a top-level section
 * heading, `title_2` a subsection, and so on; they render below the `<h1>`
 * article title.
 */
function headingLevelFor(passageType: string): number | null {
  const match = passageType.match(/^title(?:_(\d+))?$/);
  if (!match) return null;
  const depth = match[1] ? Number.parseInt(match[1], 10) : 1;
  return Math.min(1 + Math.max(depth, 1), 6);
}

type PmcConversion = {
  html: string;
  title: string;
};

/**
 * Converts a BioC collection into an HTML document the normal transformer
 * pipeline can turn into Markdown. Throws `EngineError` when the payload does
 * not actually carry usable full text, so the caller falls back to the
 * ordinary engines rather than reporting an empty success.
 */
export function convertBiocToHtml(
  collections: unknown,
  sourceUrl: string,
  pmcId: string,
): PmcConversion {
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new EngineError("PMC BioC payload was not a collection array");
  }

  const document = (collections as BiocCollection[])
    .flatMap(c => c?.documents ?? [])
    .find(d => Array.isArray(d?.passages) && d.passages.length > 0);

  if (!document) {
    throw new EngineError("PMC BioC payload contained no document passages");
  }

  const passages = document.passages ?? [];
  const frontInfons =
    passages.find(p => (p.infons?.type ?? "") === "front")?.infons ?? {};

  const title =
    passages.find(p => (p.infons?.type ?? "") === "front")?.text?.trim() ||
    passages
      .find(p => (p.infons?.section_type ?? "") === "TITLE")
      ?.text?.trim() ||
    "";

  const authors = Object.entries(frontInfons)
    .filter(([key]) => /^name_\d+$/.test(key))
    .sort(
      ([a], [b]) =>
        Number.parseInt(a.slice(5), 10) - Number.parseInt(b.slice(5), 10),
    )
    .map(([, value]) => formatAuthor(value))
    .filter((x): x is string => x !== null);

  const body: string[] = [];
  const references: string[] = [];
  let abstractHeadingEmitted = false;
  let bodyTextLength = 0;

  for (const passage of passages) {
    const type = (passage.infons?.type ?? "").toLowerCase();
    const text = (passage.text ?? "").trim();
    if (text.length === 0) continue;

    if (type === "front") continue; // rendered as <h1> below

    if (type === "ref") {
      references.push(`<li>${escapeHtml(text)}</li>`);
      continue;
    }

    if (type === "abstract" || type.startsWith("abstract_")) {
      if (!abstractHeadingEmitted) {
        body.push("<h2>Abstract</h2>");
        abstractHeadingEmitted = true;
      }
      body.push(`<p>${escapeHtml(text)}</p>`);
      bodyTextLength += text.length;
      continue;
    }

    const headingLevel = headingLevelFor(type);
    if (headingLevel !== null) {
      body.push(`<h${headingLevel}>${escapeHtml(text)}</h${headingLevel}>`);
      continue;
    }

    if (type === "table") {
      body.push(`<pre>${escapeHtml(text)}</pre>`);
      bodyTextLength += text.length;
      continue;
    }

    if (type.endsWith("caption") || type.endsWith("footnote")) {
      body.push(`<p><em>${escapeHtml(text)}</em></p>`);
      bodyTextLength += text.length;
      continue;
    }

    body.push(`<p>${escapeHtml(text)}</p>`);
    bodyTextLength += text.length;
  }

  // A payload with only a title (or only reference stubs) is not full text —
  // treat it as unavailable so the waterfall gets a chance.
  if (title.length === 0 || bodyTextLength < 200) {
    throw new EngineError(
      "PMC BioC payload carried no usable full text (non-open-access or metadata-only record)",
    );
  }

  if (references.length > 0) {
    body.push(`<h2>References</h2><ol>${references.join("")}</ol>`);
  }

  const metaTags: string[] = [
    `<meta name="citation_pmcid" content="${escapeHtml(pmcId)}">`,
    `<meta name="citation_title" content="${escapeHtml(title)}">`,
    `<meta name="citation_public_url" content="${escapeHtml(sourceUrl)}">`,
    `<meta name="firecrawl:source" content="pmc-bioc">`,
  ];
  const optionalMeta: [string, string | undefined][] = [
    ["citation_doi", frontInfons["article-id_doi"]],
    ["citation_pmid", frontInfons["article-id_pmid"]],
    ["citation_journal_title", frontInfons["journal"]],
    ["citation_volume", frontInfons["volume"]],
    ["citation_date", frontInfons["year"]],
    ["keywords", frontInfons["kwd"]],
    ["license", frontInfons["license"] ?? document.infons?.license],
  ];
  for (const [name, value] of optionalMeta) {
    if (value) {
      metaTags.push(
        `<meta name="${name}" content="${escapeHtml(String(value))}">`,
      );
    }
  }
  for (const author of authors) {
    metaTags.push(
      `<meta name="citation_author" content="${escapeHtml(author)}">`,
    );
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(sourceUrl)}">
  ${metaTags.join("\n  ")}
</head>
<body>
  <article>
    <h1>${escapeHtml(title)}</h1>
    ${authors.length > 0 ? `<p>${escapeHtml(authors.join(", "))}</p>` : ""}
    ${body.join("\n    ")}
  </article>
</body>
</html>`;

  return { html, title };
}

export async function scrapeURLWithPmcBioc(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const url = meta.rewrittenUrl ?? meta.url;
  const pmcId = extractPmcId(url);

  if (pmcId === null) {
    throw new EngineError("URL is not a supported PMC article URL");
  }

  pmcBiocCounter.inc({ outcome: "attempt" });

  const endpoint = `${BIOC_ENDPOINT}/${encodeURIComponent(pmcId)}/unicode`;
  const signal = AbortSignal.any([
    meta.abort.asSignal(),
    AbortSignal.timeout(config.PMC_BIOC_TIMEOUT_MS),
  ]);

  let response: undici.Response;
  try {
    response = await undici.fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      dispatcher: getSecureDispatcher(),
      signal,
    });
  } catch (error) {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw new EngineError(
      `PMC BioC request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status !== 200) {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw new EngineError(
      `PMC BioC returned HTTP ${response.status} for ${pmcId}`,
    );
  }

  let raw: string;
  try {
    raw = await readBounded(response, config.PMC_BIOC_MAX_RESPONSE_BYTES);
  } catch (error) {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw error instanceof EngineError
      ? error
      : new EngineError(
          `PMC BioC body read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  }

  // The API answers unknown/non-open-access IDs with HTTP 200 and an HTML
  // "[Error] : No result can be found." page, so status alone proves nothing.
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw new EngineError(
      `PMC BioC has no open-access full text for ${pmcId} (non-JSON response)`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw new EngineError(`PMC BioC returned malformed JSON for ${pmcId}`);
  }

  let converted: PmcConversion;
  try {
    converted = convertBiocToHtml(parsed, url, pmcId);
  } catch (error) {
    pmcBiocCounter.inc({ outcome: "fallback" });
    throw error;
  }

  pmcBiocCounter.inc({ outcome: "success" });
  meta.logger.info("Retrieved PMC article from official BioC API", {
    pmcId,
    title: converted.title,
    htmlLength: converted.html.length,
  });

  return {
    url,
    html: converted.html,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    proxyUsed: "basic",
  };
}

export function pmcBiocMaxReasonableTime(_meta: Meta): number {
  return config.PMC_BIOC_TIMEOUT_MS;
}
