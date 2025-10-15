import { Request, Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { CostTracking } from "../../lib/cost-tracking";
import {
  getSearchIndexClient,
  SearchIndexClient,
  type SearchRequest,
} from "../../lib/search-index-client";

// Validation schemas
const searchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  mode: z.enum(["hybrid", "keyword", "semantic", "bm25"]).optional().default("hybrid"),
  filters: z
    .object({
      domain: z.string().optional(),
      country: z.string().length(2).optional(),
      isMobile: z.boolean().optional(),
      minFreshness: z.number().min(0).max(1).optional(),
      language: z.string().optional(),
    })
    .optional()
    .default({}),
});

const searchChunksRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional().default(20),
  filters: z
    .object({
      domain: z.string().optional(),
    })
    .optional()
    .default({}),
});

export async function realtimeSearchController(
  req: Request,
  res: Response,
): Promise<void> {
  const logger = _logger.child({
    module: "realtime-search-controller",
    method: "POST /admin/search",
    teamId: (req as any).auth?.team_id,
  });

  try {
    // Validate request
    const validationResult = searchRequestSchema.safeParse(req.body);

    if (!validationResult.success) {
      res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.errors,
      });
      return;
    }

    const { query, limit, offset, mode, filters } = validationResult.data;

    logger.info("Search request", {
      query,
      mode,
      limit,
      filters,
    });

    // Get search index client
    const client = getSearchIndexClient();
    
    if (!client) {
      res.status(503).json({
        success: false,
        error: "Search index service is not configured",
      });
      return;
    }

    // Perform search via HTTP client
    const searchRequest: SearchRequest = {
      query,
      limit,
      offset,
      mode,
      filters,
    };

    const result = await client.search(searchRequest, logger);

    // Track cost (if applicable)
    const costTracking = new CostTracking();
    // Add search cost tracking here if needed

    res.status(200).json({
      success: true,
      data: result,
      costTracking: costTracking.toJSON(),
    });
  } catch (error) {
    logger.error("Search request failed", {
      error: (error as Error).message,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: (error as Error).message,
    });
  }
}

// /**
//  * POST /admin/search/chunks
//  * Chunk-level search for precise snippets
//  */
// export async function searchChunksController(
//   req: Request,
//   res: Response,
// ): Promise<void> {
//   const logger = _logger.child({
//     module: "search-chunks-controller",
//     method: "POST /admin/search/chunks",
//     teamId: (req as any).auth?.team_id,
//   });

//   try {
//     // Validate request
//     const validationResult = searchChunksRequestSchema.safeParse(req.body);

//     if (!validationResult.success) {
//       res.status(400).json({
//         success: false,
//         error: "Invalid request parameters",
//         details: validationResult.error.errors,
//       });
//       return;
//     }

//     const { query, limit, filters } = validationResult.data;

//     logger.info("Chunk search request", {
//       query,
//       limit,
//       filters,
//     });

//     // Check if search index is enabled
//     if (!isSearchIndexEnabled()) {
//       res.status(503).json({
//         success: false,
//         error: "Search index is not configured",
//       });
//       return;
//     }

//     // Perform chunk search
//     const results = await searchChunks(
//       search_index_supabase_service,
//       query,
//       limit,
//       filters as SearchFilters,
//       logger,
//     );

//     res.status(200).json({
//       success: true,
//       data: {
//         chunks: results,
//         total: results.length,
//         query,
//       },
//     });
//   } catch (error) {
//     logger.error("Chunk search request failed", {
//       error: (error as Error).message,
//     });

//     res.status(500).json({
//       success: false,
//       error: "Internal server error",
//       message: (error as Error).message,
//     });
//   }
// }

// /**
//  * GET /admin/search/stats
//  * Get search index statistics
//  */
// export async function searchStatsController(
//   req: Request,
//   res: Response,
// ): Promise<void> {
//   const logger = _logger.child({
//     module: "search-stats-controller",
//     method: "GET /admin/search/stats",
//   });

//   try {
//     // Check if search index is enabled
//     if (!isSearchIndexEnabled()) {
//       res.status(503).json({
//         success: false,
//         error: "Search index is not configured",
//       });
//       return;
//     }

//     const stats = await getSearchStats(search_index_supabase_service);

//     res.status(200).json({
//       success: true,
//       data: stats,
//     });
//   } catch (error) {
//     logger.error("Failed to get search stats", {
//       error: (error as Error).message,
//     });

//     res.status(500).json({
//       success: false,
//       error: "Internal server error",
//       message: (error as Error).message,
//     });
//   }
// }
