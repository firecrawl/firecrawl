import { router } from './trpc';
import { scrapeRouter } from './routers/scrape';
import { crawlRouter } from './routers/crawl';

export const appRouter = router({
  scrape: scrapeRouter,
  crawl: crawlRouter,
});

export type AppRouter = typeof appRouter;
