# 🕷️ SynapticChain HTTP 402 Micropayment Integration for Firecrawl

This recipe demonstrates how to protect self-hosted Firecrawl API nodes with **native Layer-1 HTTP 402 micropayments ($0.0008 / scrape)**, enabling autonomous AI agents to pay for web scraping in sub-300ms without API keys or credit card subscriptions.

## 📦 Package
```bash
npm install @synaptics-lab/firecrawl-x402
```

## ⚡ Quickstart
```typescript
import express from 'express';
import { firecrawlX402Middleware } from '@synaptics-lab/firecrawl-x402';

const app = express();
app.use(express.json());

// Protect with $0.0008 Layer-1 Micropayments
app.use('/v1/scrape', firecrawlX402Middleware({
  feeRecipient: 'syn1dejphz2hjetjqva9fg39c7hg8gpr7muapqyvq7',
  costPerScrape: '0.0008',
  currency: 'sUSD'
}));

app.listen(3002, () => console.log('Firecrawl x402 running on port 3002'));
```

## 🌐 References
- Official Repository: https://github.com/Synaptics-Lab/firecrawl-x402
- Explorer: https://explorer.synapticchain.xyz
