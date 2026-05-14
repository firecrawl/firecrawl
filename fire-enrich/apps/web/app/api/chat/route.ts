import { NextRequest, NextResponse } from 'next/server';
import { FirecrawlService } from '@/lib/services/firecrawl';
import { OpenAIService } from '@/lib/services/openai';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  UnauthorizedError,
  requireBearer,
  withFirecrawl,
  withOpenAI,
} from '@fire-enrich/core/server';
import { getDb, type Principal } from '@fire-enrich/db';

export const runtime = 'nodejs';

// Store active queries
const activeQueries = new Map<string, AbortController>();

export async function POST(request: NextRequest) {
  // Authenticate first.
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

  let body: {
    question?: string;
    context?: { tableData?: string; [key: string]: unknown };
    conversationHistory?: Array<{ role: string; content: string }>;
    sessionId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { question, context, conversationHistory, sessionId } = body;

  if (!question || !question.trim()) {
    return NextResponse.json(
      { error: 'Question is required' },
      { status: 400 }
    );
  }

  try {
    // Create abort controller for this query
    const abortController = new AbortController();
    const queryId = sessionId || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    activeQueries.set(queryId, abortController);

    // Create streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emitFatalError = (
          code: string,
          message: string,
          scope?: 'firecrawl' | 'openai'
        ) => {
          const payload: Record<string, unknown> = { code, error: message };
          if (scope) payload.scope = scope;
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
          );
        };

        try {
          // Step 1: Check table data first
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: 'Checking enriched table data...',
                step: 'table_check'
              })}\n\n`
            )
          );

          // Try to answer from table data first
          const tableData = context?.tableData || '';
          if (tableData && tableData.trim().length > 0) {
            console.log('[Chat API] Checking table data, length:', tableData.length);
            const tableAnswer = await withOpenAI(
              principal,
              'chat',
              db,
              async (key) => {
                const openai = new OpenAIService(key.key);
                return openai.answerFromTableData(
                  question,
                  tableData,
                  conversationHistory
                );
              }
            );

            if (tableAnswer && tableAnswer.found) {
              console.log('[Chat API] Answer found in table data');
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'status',
                    message: '✓ Found answer in enriched data',
                    step: 'table_found'
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'response',
                    message: tableAnswer.answer,
                    source: { type: 'table', title: 'Enriched Data Table' }
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'complete' })}\n\n`
                )
              );
              return;
            } else {
              console.log('[Chat API] Answer not found in table, searching web');
            }
          } else {
            console.log('[Chat API] No table data available, searching web');
          }

          // Step 2: If not found in table, search the web
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: 'Searching the web for more information...',
                step: 'web_search'
              })}\n\n`
            )
          );

          // OpenAI: generate the search query.
          const searchQuery = await withOpenAI(
            principal,
            'chat',
            db,
            async (key) => {
              const openai = new OpenAIService(key.key);
              return openai.generateSearchQuery(question, {
                ...context,
                conversationHistory,
              });
            }
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: `Searching for: "${searchQuery}"`,
                step: 'search'
              })}\n\n`
            )
          );

          // Step 2: Search for relevant sources
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: 'Executing web search...',
                step: 'searching'
              })}\n\n`
            )
          );

          // Firecrawl: search + scrape, both billed under one chat-scope
          // wrapper to avoid double-recording. The scrape is also paid for
          // here (firecrawl), and the synthesis-LLM call below is billed
          // separately on the openai scope.
          const { searchResults, scrapedMarkdown, bestSource } =
            await withFirecrawl(principal, 'chat', db, async (key) => {
              const firecrawl = new FirecrawlService(key.key);
              const sr = await firecrawl.search(searchQuery, { limit: 5 });
              if (sr.length === 0) {
                return {
                  searchResults: sr,
                  scrapedMarkdown: '',
                  bestSource: null as null | { url: string; title?: string },
                };
              }

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'status',
                    message: `Found ${sr.length} sources`,
                    step: 'select',
                    sources: sr.map((r) => ({ url: r.url, title: r.title }))
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'status',
                    message: 'Evaluating source relevance...',
                    step: 'evaluating'
                  })}\n\n`
                )
              );

              // Source selection is an LLM call but it's tightly coupled
              // to the firecrawl pipeline; we run it inside this block
              // and bill it under openai separately further down. Easier
              // to keep selection here and pay it under openai inline.
              // To keep accounting clean, run selection via withOpenAI.
              const best = await withOpenAI(
                principal,
                'chat',
                db,
                async (oaKey) => {
                  const openai = new OpenAIService(oaKey.key);
                  return openai.selectBestSource(sr, question);
                }
              );

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'status',
                    message: `Selected: ${best.title || new URL(best.url).hostname}`,
                    step: 'selected',
                    source: { url: best.url, title: best.title }
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'status',
                    message: `Reading content from ${new URL(best.url).hostname}...`,
                    step: 'scrape',
                    source: { url: best.url, title: best.title }
                  })}\n\n`
                )
              );

              const scraped = await firecrawl.scrapeUrl(best.url);
              return {
                searchResults: sr,
                scrapedMarkdown: scraped.data?.markdown || '',
                bestSource: best,
              };
            });

          if (searchResults.length === 0 || !bestSource) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'response',
                  message: "I couldn't find any relevant information. Could you rephrase your question?"
                })}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'complete' })}\n\n`
              )
            );
            return;
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: 'Extracting relevant information...',
                step: 'extracting'
              })}\n\n`
            )
          );

          // Step 5: Analyzing and formulating response
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                message: 'Synthesizing answer...',
                step: 'analyze'
              })}\n\n`
            )
          );

          // Synthesis LLM call billed under openai/synthesis.
          const response = await withOpenAI(
            principal,
            'synthesis',
            db,
            async (key) => {
              const openai = new OpenAIService(key.key);
              return openai.generateConversationalResponse(
                question,
                scrapedMarkdown,
                {
                  ...context,
                  conversationHistory,
                },
                bestSource.url
              );
            }
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response',
                message: response,
                source: { url: bestSource.url, title: bestSource.title }
              })}\n\n`
            )
          );

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'complete' })}\n\n`
            )
          );

        } catch (error) {
          console.error('[Chat API] Error:', error);
          if (error instanceof QuotaExceededError) {
            emitFatalError(error.code, error.message, error.scope);
          } else if (error instanceof NoKeyAvailableError) {
            emitFatalError(error.code, error.message, error.scope);
          } else {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'error',
                  message: error instanceof Error ? error.message : 'An error occurred'
                })}\n\n`
              )
            );
          }
        } finally {
          activeQueries.delete(queryId);
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
    console.error('[Chat API] Failed to process request:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

// Stop endpoint. Like /api/enrich's DELETE, queryId is treated as a
// capability — no bearer required.
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const queryId = searchParams.get('queryId');

  if (!queryId) {
    return NextResponse.json(
      { error: 'Query ID required' },
      { status: 400 }
    );
  }

  const controller = activeQueries.get(queryId);
  if (controller) {
    controller.abort();
    activeQueries.delete(queryId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: 'Query not found' },
    { status: 404 }
  );
}
