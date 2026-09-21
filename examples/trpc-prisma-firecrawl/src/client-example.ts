import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './types';
const client = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'http://localhost:3000/trpc',
    }),
  ],
});

async function exampleUsage() {
  console.log('tRPC + Prisma + Firecrawl Example\n');

  try {
    console.log('Scraping a single URL...');
    const scrapeResult = await client.scrape.scrapeUrl.mutate({
      url: 'https://example.com',
      includeMarkdown: true,
      includeHtml: false,
      onlyMainContent: true,
    });

    if (scrapeResult.success) {
      console.log('Scrape successful!');
      console.log('Job ID:', scrapeResult.job.id);
      console.log('Title:', scrapeResult.job.title);
      console.log('Status:', scrapeResult.job.status);
    } else {
      console.log('Scrape failed:', 'error' in scrapeResult ? scrapeResult.error : 'Unknown error');
    }

    console.log('\nListing all scrape jobs...');
    const jobsList = await client.scrape.listJobs.query({
      limit: 10,
      offset: 0,
    });

    console.log(`Found ${jobsList.total} jobs:`);
    jobsList.jobs.forEach((job, index) => {
      console.log(`${index + 1}. ${job.url} - ${job.status} (${job.createdAt})`);
    });

    console.log('\nCrawling a website...');
    const crawlResult = await client.crawl.crawlUrl.mutate({
      baseUrl: 'https://example.com',
      maxPages: 3,
      allowExternalLinks: false,
      includeMarkdown: true,
      onlyMainContent: true,
    });

    if (crawlResult.success) {
      console.log('Crawl successful!');
      console.log('Job ID:', crawlResult.job.id);
      console.log('Total pages:', crawlResult.job.totalPages);
      console.log('Status:', crawlResult.job.status);
    } else {
      console.log('Crawl failed:', 'error' in crawlResult ? crawlResult.error : 'Unknown error');
    }

    if (scrapeResult.success) {
      console.log('\nGetting job details...');
      const jobDetails = await client.scrape.getJob.query({
        id: scrapeResult.job.id,
      });

      console.log('Job details:');
      console.log('- URL:', jobDetails.url);
      console.log('- Status:', jobDetails.status);
      console.log('- Created:', jobDetails.createdAt);
      console.log('- Title:', jobDetails.title);
      console.log('- Content length:', jobDetails.content?.length || 0, 'characters');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}
if (require.main === module) {
  exampleUsage().catch(console.error);
}

export { client };
