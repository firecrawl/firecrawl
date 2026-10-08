# Firecrawl knowledge graph browser viewer

Open Firecrawl's `knowledgeGraph` output in a browser without installing a desktop graph application or running a server. Nodes and relationships are draggable, searchable, and clickable to inspect their attributes.

## Prerequisites

- A modern browser on Linux (Firefox or Chromium).
- No network connection is required: Cytoscape.js 3.30.4 is included locally (`cytoscape.min.js`; see `CYTOSCAPE-LICENSE.txt`). The graph JSON stays in the browser; opening this HTML does not upload it.
- A Firecrawl `knowledgeGraph` JSON result.

## Usage

1. Open `index.html` in your browser, e.g. `firefox examples/kg-generator/firecrawl-kg-browser-viewer/index.html` from the fork root.
2. Choose a `.json` file or paste JSON into the box and click **Show graph**.
3. Drag to pan, scroll to zoom, search node labels/types/IDs, and click a node or edge for properties.

Accepted JSON shapes: `{"nodes":[...],"edges":[...]}`, `{"knowledgeGraph":{...}}`, or `{"data":{"knowledgeGraph":{...}}}` (a full scrape response or merged search response). For a crawl, select an individual page's `knowledgeGraph`; this viewer does not merge pages. It displays a single graph and does not validate whether the LLM's facts are true.

Example: paste `{"nodes":[{"id":"ada","label":"Ada Lovelace","type":"Person","properties":[{"key":"role","value":"mathematician"}]},{"id":"engine","label":"Analytical Engine","type":"Product"}],"edges":[{"source":"ada","target":"engine","relation":"described"}]}`.

## Expected output

A laid-out graph with two labeled nodes and a `described` arrow for the example above. The status line reports node/edge counts; invalid JSON and missing endpoints produce errors in the sidebar.
