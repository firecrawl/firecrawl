# API context

_Date: 2026-10-07_

_Anchors:_ `apps/api/src/scraper/scrapeURL/transformers/knowledgeGraph.ts::performKnowledgeGraph`, `apps/api/src/scraper/scrapeURL/transformers/knowledgeGraph.ts::correctInfoboxParentDirection`, `apps/api/src/scraper/scrapeURL/transformers/knowledgeGraphUtils.ts::mergeKnowledgeGraphs`, `apps/api/src/search/execute.ts::executeSearch`

**Knowledge graph:** the opt-in `knowledgeGraph` scrape format extracts entities and directed relationships from page content. It is a structured LLM output, not an indexed graph database or a fact-verification service. Extraction runs after markdown derivation and omits markdown from the response unless markdown was requested. The caller's `entityTypes` list is enforced after generation, not trusted solely to the prompt.

**Per-page versus merged graph:** scrape and crawl return a graph on each document. Search retains graphs on scraped results and adds a top-level graph merging matching entities across web and news results. The pure normalization and edge-integrity rules live in `knowledgeGraphUtils.ts`; do not silently change the identity contract without checking those tests.

**Direction evidence:** the model can reverse asymmetric relationships even when instructed not to. A Wikipedia-style article infobox with explicitly labelled parents can justify correcting that specific subject-to-parent edge; other edges must not be flipped based on relation name alone. The remaining output is still LLM-generated, not fact-verified.

**Boundaries:** graph generation needs a configured LLM provider and is skipped with a warning under zero-data-retention. The warning/empty-result behavior and retry path are tested in `knowledgeGraph.test.ts`; the API request contracts are tested in `controllers/v2/knowledgeGraphFormat.test.ts`. A live scrape/search/crawl check still requires a running API and LLM credentials.
