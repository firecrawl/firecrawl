import express from 'express';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from './types';

const app = express();

app.use(cors());
app.use(express.json());

app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext: () => ({}),
  })
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    message: 'tRPC + Prisma + Firecrawl API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      trpc: '/trpc',
      documentation: 'https://trpc.io/docs',
    },
    availableProcedures: {
      scrape: {
        scrapeUrl: 'POST /trpc/scrape.scrapeUrl',
        getJob: 'GET /trpc/scrape.getJob',
        listJobs: 'GET /trpc/scrape.listJobs',
        deleteJob: 'DELETE /trpc/scrape.deleteJob',
      },
      crawl: {
        crawlUrl: 'POST /trpc/crawl.crawlUrl',
        getJob: 'GET /trpc/crawl.getJob',
        listJobs: 'GET /trpc/crawl.listJobs',
        deleteJob: 'DELETE /trpc/crawl.deleteJob',
      },
    },
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`tRPC endpoint: http://localhost:${PORT}/trpc`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export type { AppRouter } from './types';
