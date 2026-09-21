# tRPC + Prisma + Firecrawl Integration

This example demonstrates how to build a type-safe web scraping API using **tRPC**, **Prisma**, and **Firecrawl**. It provides a robust backend with database persistence, job management, and reliable web scraping capabilities.

## Features

- **Type-safe API** with tRPC for end-to-end type safety
- **Database persistence** with Prisma ORM and SQLite
- **Web scraping** with Firecrawl for reliable content extraction
- **Job management** with status tracking and error handling
- **RESTful endpoints** with Express.js
- **CORS support** for cross-origin requests

## Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- Firecrawl API key ([Get one here](https://firecrawl.dev))

## Installation

1. Clone this repository and navigate to the example:

```bash
cd examples/trpc-prisma-firecrawl
```

2. Install dependencies:

```bash
pnpm install
# or
npm install
```

3. Set up environment variables:

```bash
cp env.example .env
```

Edit `.env` and add your Firecrawl API key:

```env
FIRECRAWL_API_KEY=your-api-key-here
```

4. Set up the database:

```bash
pnpm run db:generate
pnpm run db:push
```

## Usage

### Start the server

```bash
pnpm run dev
```

The server will start on `http://localhost:3000`

### API Endpoints

#### Health Check
```bash
curl http://localhost:3000/health
```

#### Scrape a URL
```bash
curl -X POST http://localhost:3000/trpc/scrape.scrapeUrl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "includeMarkdown": true}'
```

#### List Scrape Jobs
```bash
curl "http://localhost:3000/trpc/scrape.listJobs?limit=10&offset=0&status=completed"
```

#### Get Job Details
```bash
curl "http://localhost:3000/trpc/scrape.getJob?id=job-id"
```

#### Delete Job
```bash
curl -X POST http://localhost:3000/trpc/scrape.deleteJob \
  -H "Content-Type: application/json" \
  -d '{"id": "job-id"}'
```

#### Crawl a Website
```bash
curl -X POST http://localhost:3000/trpc/crawl.crawlUrl \
  -H "Content-Type: application/json" \
  -d '{"baseUrl": "https://example.com", "maxPages": 5}'
```

### TypeScript Client

```typescript
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './src/types';

const client = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'http://localhost:3000/trpc',
    }),
  ],
});

// Scrape a URL
const result = await client.scrape.scrapeUrl.mutate({
  url: 'https://example.com',
  includeMarkdown: true,
});

console.log(result);
```

### Run the Example

```bash
# Start the server
pnpm run dev

# In another terminal, run the client example
npx tsx src/client-example.ts
```

## Database Schema

### ScrapeJob
- `id` - Unique job identifier
- `url` - URL to scrape
- `status` - Job status (pending, completed, failed)
- `title` - Scraped page title
- `content` - Scraped content
- `markdown` - Markdown formatted content
- `html` - HTML content (optional)
- `metadata` - Additional metadata (JSON string)
- `error` - Error message (if failed)
- `createdAt` - Job creation timestamp
- `updatedAt` - Last update timestamp
- `completedAt` - Completion timestamp

### CrawlJob
- `id` - Unique job identifier
- `baseUrl` - Base URL to crawl
- `status` - Job status (pending, completed, failed)
- `maxPages` - Maximum pages to crawl
- `allowExternalLinks` - Whether to allow external links
- `pages` - Array of scraped pages (JSON string)
- `totalPages` - Total pages crawled
- `error` - Error message (if failed)
- `createdAt` - Job creation timestamp
- `updatedAt` - Last update timestamp
- `completedAt` - Completion timestamp

## Available Scripts

- `pnpm run dev` - Start development server with hot reload
- `pnpm run build` - Build the project
- `pnpm run start` - Start production server
- `pnpm run db:generate` - Generate Prisma client
- `pnpm run db:push` - Push schema changes to database
- `pnpm run db:studio` - Open Prisma Studio

## Tech Stack

- **tRPC** - End-to-end typesafe APIs
- **Prisma** - Next-generation ORM for Node.js and TypeScript
- **Firecrawl** - Web scraping and crawling service
- **Express.js** - Web framework for Node.js
- **TypeScript** - Typed JavaScript
- **SQLite** - Lightweight database (easily switchable to PostgreSQL)

## Production Considerations

- Switch from SQLite to PostgreSQL for production
- Set up proper secret management
- Configure CORS properly for your domain
- Add logging and monitoring
- Consider using a job queue for large-scale scraping
- Implement rate limiting

## Learn More

- [tRPC Documentation](https://trpc.io/docs)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Firecrawl Documentation](https://docs.firecrawl.dev)
- [Express.js Documentation](https://expressjs.com/)