import { NextRequest, NextResponse } from 'next/server';
import { AgentEnrichmentStrategy } from '@/lib/strategies/agent-enrichment-strategy';
import type { EnrichmentRequest, RowEnrichmentResult } from '@/lib/types';
import { loadSkipList, shouldSkipEmail, getSkipReason } from '@/lib/utils/skip-list';
import { ENRICHMENT_CONFIG } from '@/lib/config/enrichment';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  UnauthorizedError,
  requireBearer,
  resolveFirecrawlKey,
  resolveOpenAIKey,
} from '@fire-enrich/core/server';
import { getDb, recordUsage, type Principal } from '@fire-enrich/db';

// Use Node.js runtime for better compatibility
export const runtime = 'nodejs';

// Store active sessions in memory (in production, use Redis or similar).
// The sessionId itself is treated as an unguessable capability — DELETE
// does not require a bearer in v1. The token is generated server-side and
// only ever returned to the client that started the stream.
const activeSessions = new Map<string, AbortController>();

export async function POST(request: NextRequest) {
  // Add request body size check
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) { // 5MB limit
    return NextResponse.json(
      { error: 'Request body too large' },
      { status: 413 }
    );
  }

  // Authenticate before consuming the body so we 401 quickly.
  const db = getDb();
  let principal: Principal;
  try {
    principal = await requireBearer(request.headers, db);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: 401 }
      );
    }
    throw err;
  }

  let body: EnrichmentRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { rows, fields, emailColumn, nameColumn } = body;

  if (!rows || rows.length === 0) {
    return NextResponse.json(
      { error: 'No rows provided' },
      { status: 400 }
    );
  }

  if (!fields || fields.length === 0 || fields.length > 10) {
    return NextResponse.json(
      { error: 'Please provide 1-10 fields to enrich' },
      { status: 400 }
    );
  }

  if (!emailColumn) {
    return NextResponse.json(
      { error: 'Email column is required' },
      { status: 400 }
    );
  }

  // Resolve keys up front so we can fail fast (503 / no_key_available)
  // before opening the SSE stream. Quota is checked lazily per row inside
  // the stream so a mid-stream exhaustion can still emit a clean SSE
  // error event instead of a 500.
  let firecrawlKey: { key: string; source: 'byok' | 'pooled' };
  let openaiKey: { key: string; source: 'byok' | 'pooled' };
  try {
    firecrawlKey = resolveFirecrawlKey(principal);
    openaiKey = resolveOpenAIKey(principal);
  } catch (err) {
    if (err instanceof NoKeyAvailableError) {
      return NextResponse.json(
        { code: err.code, error: err.message, scope: err.scope },
        { status: 503 }
      );
    }
    throw err;
  }

  try {
    // Use a more compatible UUID generation
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const abortController = new AbortController();
    activeSessions.set(sessionId, abortController);

    // Always use the advanced agent architecture
    const strategyName = 'AgentEnrichmentStrategy';

    console.log(`[STRATEGY] Using ${strategyName} - Advanced multi-agent architecture with specialized agents`);
    const enrichmentStrategy = new AgentEnrichmentStrategy(
      openaiKey.key,
      firecrawlKey.key
    );

    // Load skip list
    const skipList = await loadSkipList();

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Helper: record one usage event per enriched row, best-effort.
        const recordRowUsage = async (ok: 0 | 1) => {
          // Each enriched row consumes from BOTH firecrawl + openai pools.
          // Record one event per scope so quota accounting stays accurate.
          await Promise.all([
            recordUsage(
              {
                principalId: principal.id,
                scope: 'firecrawl',
                op: 'enrich_row',
                source: firecrawlKey.source,
                ok,
              },
              db as never
            ).catch((e) => console.error('failed to record firecrawl usage', e)),
            recordUsage(
              {
                principalId: principal.id,
                scope: 'openai',
                op: 'enrich_row',
                source: openaiKey.source,
                ok,
              },
              db as never
            ).catch((e) => console.error('failed to record openai usage', e)),
          ]);
        };

        // Emit a final SSE error event then close. Used when quota
        // exhaustion or another fatal error occurs mid-stream so we don't
        // 500 the connection.
        const emitFatalError = (
          code: string,
          message: string,
          scope?: 'firecrawl' | 'openai'
        ) => {
          const payload: Record<string, unknown> = { code, error: message };
          if (scope) payload.scope = scope;
          // SSE convention: an explicit `event:` channel + JSON data.
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
          );
        };

        try {
          // Send session ID
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`
            )
          );

          // Process rows with rolling concurrency (as each finishes, start the next)
          const concurrency = ENRICHMENT_CONFIG.CONCURRENT_ROWS;
          console.log(`[ENRICHMENT] Processing ${rows.length} rows with rolling concurrency: ${concurrency}`);

          // Send pending status for all rows
          for (let i = 0; i < rows.length; i++) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'pending',
                  rowIndex: i,
                  totalRows: rows.length,
                })}\n\n`
              )
            );
          }

          // Quota state — once tripped, we abort outstanding work and
          // emit a single fatal SSE error. We cache the error so the
          // outer loop can detect it and break cleanly.
          let quotaError: QuotaExceededError | null = null;

          // Process rows with rolling concurrency
          const processRow = async (i: number) => {
            // Check if cancelled
            if (abortController.signal.aborted) {
              return;
            }
            if (quotaError) return;

            const row = rows[i];
            const email = row[emailColumn];

            // Add name to row context if nameColumn is provided
            if (nameColumn && row[nameColumn]) {
              row._name = row[nameColumn];
            }

            // Check if email should be skipped
            if (email && shouldSkipEmail(email, skipList)) {
              const skipReason = getSkipReason(email, skipList);

              // Send skip result
              const skipResult: RowEnrichmentResult = {
                rowIndex: i,
                originalData: row,
                enrichments: {},
                status: 'skipped',
                error: skipReason,
              };

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'result',
                    result: skipResult,
                  })}\n\n`
                )
              );

              return;
            }

            // Send processing status
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'processing',
                  rowIndex: i,
                  totalRows: rows.length,
                })}\n\n`
              )
            );

            // Quota check — only when at least one resolved key is pooled.
            // BYOK calls aren't subject to fire-enrich's quota; the upstream
            // fork enforces them. We import the check lazily via dynamic
            // import to keep this route tree-shake-friendly even though
            // it's tiny.
            if (
              firecrawlKey.source === 'pooled' ||
              openaiKey.source === 'pooled'
            ) {
              try {
                const { enforceQuota } = await import('@fire-enrich/core/server');
                if (firecrawlKey.source === 'pooled') {
                  await enforceQuota(principal, 'firecrawl', db);
                }
                if (openaiKey.source === 'pooled') {
                  await enforceQuota(principal, 'openai', db);
                }
              } catch (err) {
                if (err instanceof QuotaExceededError) {
                  quotaError = err;
                  abortController.abort();
                  return;
                }
                throw err;
              }
            }

            try {
              // Enrich the row
              console.log(`[ENRICHMENT] Processing row ${i + 1}/${rows.length} - Email: ${email} - Strategy: ${strategyName}`);
              const startTime = Date.now();

              // Agent strategies return RowEnrichmentResult
              const result = await enrichmentStrategy.enrichRow(
                row,
                fields,
                emailColumn,
                undefined, // onProgress
                (message: string, type: 'info' | 'success' | 'warning' | 'agent', sourceUrl?: string) => {
                  // Stream agent progress messages
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: 'agent_progress',
                        rowIndex: i,
                        message,
                        messageType: type,
                        sourceUrl, // Include sourceUrl for favicons
                      })}\n\n`
                    )
                  );
                }
              );
              result.rowIndex = i; // Set the correct row index

              const duration = Date.now() - startTime;
              console.log(`[ENRICHMENT] Completed row ${i + 1} in ${duration}ms - Fields enriched: ${Object.keys(result.enrichments).length}`);

              // Log which fields were successfully enriched
              const enrichedFields = Object.entries(result.enrichments)
                .filter(([, enrichment]) => enrichment.value)
                .map(([fieldName, enrichment]) => `${fieldName}: ${enrichment.value ? '✓' : '✗'}`)
                .join(', ');
              if (enrichedFields) {
                console.log(`[ENRICHMENT] Fields: ${enrichedFields}`);
              }

              // Send result
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'result',
                    result,
                  })}\n\n`
                )
              );
              await recordRowUsage(1);
            } catch (error) {
              await recordRowUsage(0);
              // Send error for this row
              const errorResult: RowEnrichmentResult = {
                rowIndex: i,
                originalData: row,
                enrichments: {},
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
              };

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'result',
                    result: errorResult,
                  })}\n\n`
                )
              );
            }
          };

          // Create a queue and process with rolling concurrency
          let currentIndex = 0;
          const activePromises: Promise<void>[] = [];

          while (currentIndex < rows.length || activePromises.length > 0) {
            // Check if cancelled
            if (abortController.signal.aborted) {
              if (!quotaError) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: 'cancelled' })}\n\n`
                  )
                );
              }
              break;
            }

            // Start new rows up to concurrency limit
            while (currentIndex < rows.length && activePromises.length < concurrency) {
              const rowIndex = currentIndex++;
              const promise = processRow(rowIndex).then(() => {
                // Remove this promise from active list when done
                const index = activePromises.indexOf(promise);
                if (index > -1) {
                  activePromises.splice(index, 1);
                }
              });
              activePromises.push(promise);
            }

            // Wait for at least one to finish before continuing
            if (activePromises.length > 0) {
              await Promise.race(activePromises);
            }
          }

          // If quota tripped mid-stream, drain remaining work and emit
          // a fatal error event instead of `complete`.
          if (quotaError) {
            await Promise.allSettled(activePromises);
            emitFatalError(
              quotaError.code,
              quotaError.message,
              quotaError.scope
            );
          } else {
            // Send completion
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'complete' })}\n\n`
              )
            );
          }
        } catch (error) {
          // Catch-all: errors that escape per-row handling. Quota errors
          // are already handled above; anything else becomes a generic
          // SSE error event.
          if (error instanceof QuotaExceededError) {
            emitFatalError(error.code, error.message, error.scope);
          } else {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'error',
                  error: error instanceof Error ? error.message : 'Unknown error',
                })}\n\n`
              )
            );
          }
        } finally {
          activeSessions.delete(sessionId);
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Failed to start enrichment:', error);
    return NextResponse.json(
      {
        error: 'Failed to start enrichment',
        details: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

// Cancel endpoint. The sessionId is treated as a capability — possession
// of an unguessable id is enough to abort. No bearer required.
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json(
      { error: 'Session ID required' },
      { status: 400 }
    );
  }

  const controller = activeSessions.get(sessionId);
  if (controller) {
    controller.abort();
    activeSessions.delete(sessionId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: 'Session not found' },
    { status: 404 }
  );
}
