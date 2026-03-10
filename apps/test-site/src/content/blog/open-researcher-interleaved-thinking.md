---
title: "Open Researcher, our AI Agent That Uses Firecrawl Tools During Research"
description: "We built a research agent using Anthropic's interleaved thinking and Firecrawl. No orchestration needed."
pubDate: "Jul 01, 2025"
heroImage: "../../assets/blog/or_firecrawl.webp"
category: "updates"
---

We’ve been building research agents for a while now. State machines, workflow engines, decision trees - the usual suspects. They work fine for predictable tasks, but research queries are rarely predictable.

So we tried something different with Anthropic’s new interleaved thinking feature. Instead of pre-defining every possible research path, we let the AI think through what it needs to do.

## The Problem with Traditional Orchestration

Most AI agents follow predefined workflows. Search → Extract → Summarize. Works great until someone asks something that doesn’t fit the pattern.

We kept hitting this wall. Users would ask complex research questions that needed different approaches. Our workflows would either fail or take inefficient paths. Adding more branches to the decision tree just made it more brittle.

## How Interleaved Thinking Works

Anthropic released a feature where AI can insert thinking blocks between actions. Not hidden reasoning - actual visible thoughts about what to do next.

Here’s what it looks like in practice:

```
Thinking Block #1: They're asking about the 3rd blog post on firecrawl.dev.
I need to find the blog listing first to count posts chronologically.

Thinking Block #2: I should search for 'site:firecrawl.dev/blog' to get
all blog posts. Then I can identify which one is third.

Thinking Block #3: Actually, I might need to scrape the blog index page
to see the proper ordering. Let me do that after the search.
```

The AI reasons through each step before taking action. No predefined workflow needed.

## What We Built

Open Researcher combines:

- Anthropic’s interleaved thinking for reasoning
- Firecrawl for web data extraction
- Basic search capabilities

That’s it. No complex orchestration layer. The AI decides which tools to use based on its reasoning.

Example of it self-correcting:

```
Thinking Block #7: I searched for recent React features but got results
from 2023. I should add '2024' to my search query.

Thinking Block #8: These results conflict. Let me check the official
React blog directly with a targeted search.
```

## Real-World Performance

We’ve tested it on various research tasks:

**Technical Documentation Research:** The AI figures out which docs to check, identifies outdated information, and cross-references multiple sources without explicit instructions.

**Company Research:** It develops its own strategy for finding team information, checking multiple sources like company pages and LinkedIn when needed.

**API Investigation:** It reasons through authentication requirements, finds example code, and identifies missing documentation.

Is it perfect? No. Sometimes it takes longer routes than necessary. Sometimes the thinking is verbose. But it handles edge cases that would break traditional workflows.

## The Code

Open Researcher is open source. The core logic is surprisingly simple - most of the complexity is handled by the AI’s reasoning.

Clone it: [github.com/firecrawl/open-researcher](https://github.com/firecrawl/open-researcher)

Try it on your own research problems. The thinking blocks make it easy to debug when something goes wrong. You can see exactly why it made each decision.

## What We Learned

Letting AI reason through tool usage eliminates a lot of orchestration complexity. Instead of predicting every path, you let the AI figure out the path.

This approach won’t replace all workflows. Predictable, high-volume tasks still benefit from traditional orchestration. But for research and exploration tasks, thinking-based agents are surprisingly effective.

We’re still experimenting with this approach. If you try it out, let us know what works and what doesn’t. The more real-world usage we see, the better we can make it.
