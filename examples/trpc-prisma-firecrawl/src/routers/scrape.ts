import { router, publicProcedure, scrapeUrlSchema, getJobSchema, listJobsSchema } from '../trpc';
import { PrismaClient } from '@prisma/client';
import { scrapeUrl } from '../firecrawl';

const prisma = new PrismaClient();

export const scrapeRouter = router({
  scrapeUrl: publicProcedure
    .input(scrapeUrlSchema)
    .mutation(async ({ input }) => {
      const job = await prisma.scrapeJob.create({
        data: {
          url: input.url,
          status: 'pending',
        },
      });

      try {
        const result = await scrapeUrl(input.url, {
          includeHtml: input.includeHtml,
          includeMarkdown: input.includeMarkdown,
          onlyMainContent: input.onlyMainContent,
        });

        if (result.success && result.data) {
          const updatedJob = await prisma.scrapeJob.update({
            where: { id: job.id },
            data: {
              status: 'completed',
              title: result.data.title,
              content: result.data.content,
              markdown: result.data.markdown,
              html: result.data.html,
              metadata: result.data.metadata ? JSON.stringify(result.data.metadata) : null,
              completedAt: new Date(),
            },
          });

          return {
            success: true,
            job: updatedJob,
          };
        } else {
          const updatedJob = await prisma.scrapeJob.update({
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
        const updatedJob = await prisma.scrapeJob.update({
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
      const job = await prisma.scrapeJob.findUnique({
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
        prisma.scrapeJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          skip: input.offset,
        }),
        prisma.scrapeJob.count({ where }),
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
      const job = await prisma.scrapeJob.delete({
        where: { id: input.id },
      });

      return { success: true, job };
    }),
});
