import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const scrapeUrlSchema = z.object({
  url: z.string().url('Invalid URL format'),
  includeHtml: z.boolean().optional().default(false),
  includeMarkdown: z.boolean().optional().default(true),
  onlyMainContent: z.boolean().optional().default(true),
});

export const crawlUrlSchema = z.object({
  baseUrl: z.string().url('Invalid URL format'),
  maxPages: z.number().min(1).max(100).optional().default(10),
  allowExternalLinks: z.boolean().optional().default(false),
  includeHtml: z.boolean().optional().default(false),
  includeMarkdown: z.boolean().optional().default(true),
  onlyMainContent: z.boolean().optional().default(true),
});

export const getJobSchema = z.object({
  id: z.string(),
});

export const listJobsSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20),
  offset: z.number().min(0).optional().default(0),
  status: z.enum(['pending', 'completed', 'failed']).optional(),
});
