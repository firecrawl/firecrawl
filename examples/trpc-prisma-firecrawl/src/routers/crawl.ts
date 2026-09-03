import { router, publicProcedure, crawlUrlSchema, getJobSchema, listJobsSchema } from '../trpc';
import { PrismaClient } from '@prisma/client';
import { crawlUrl } from '../firecrawl';

const prisma = new PrismaClient();

export const crawlRouter = router({
  crawlUrl: publicProcedure
    .input(crawlUrlSchema)
    .mutation(async ({ input }) => {
      const job = await prisma.crawlJob.create({
        data: {
          baseUrl: input.baseUrl,
          status: 'pending',
          maxPages: input.maxPages,
          allowExternalLinks: input.allowExternalLinks,
        },
      });

      try {
        const result = await crawlUrl(input.baseUrl, {
          maxPages: input.maxPages,
          allowExternalLinks: input.allowExternalLinks,
          includeHtml: input.includeHtml,
          includeMarkdown: input.includeMarkdown,
          onlyMainContent: input.onlyMainContent,
        });

        if (result.success && result.data) {
          const updatedJob = await prisma.crawlJob.update({
            where: { id: job.id },
            data: {
              status: 'completed',
              pages: JSON.stringify(result.data.pages),
              totalPages: result.data.totalPages,
              completedAt: new Date(),
            },
          });

          return {
            success: true,
            job: updatedJob,
          };
        } else {
          const updatedJob = await prisma.crawlJob.update({
            where: { id: job.id },
            data: {
              status: 'failed',
              error: result.error || 'Unknown error',
              completedAt: new Date(),
            },
          });

          return {
            success: false,
            job: updatedJob,
            error: result.error,
          };
        }
      } catch (error) {
        const updatedJob = await prisma.crawlJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
            completedAt: new Date(),
          },
        });

        return {
          success: false,
          job: updatedJob,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }),

  getJob: publicProcedure
    .input(getJobSchema)
    .query(async ({ input }) => {
      const job = await prisma.crawlJob.findUnique({
        where: { id: input.id },
      });

      if (!job) {
        throw new Error('Job not found');
      }

      return job;
    }),

  listJobs: publicProcedure
    .input(listJobsSchema)
    .query(async ({ input }) => {
      const where = input.status ? { status: input.status } : {};
      
      const [jobs, total] = await Promise.all([
        prisma.crawlJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          skip: input.offset,
        }),
        prisma.crawlJob.count({ where }),
      ]);

      return {
        jobs,
        total,
        hasMore: input.offset + input.limit < total,
      };
    }),

  deleteJob: publicProcedure
    .input(getJobSchema)
    .mutation(async ({ input }) => {
      const job = await prisma.crawlJob.delete({
        where: { id: input.id },
      });

      return { success: true, job };
    }),
});
