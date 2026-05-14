'use client';

import { Loader2, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ErrorAlert, type ApiError } from './ErrorAlert';
import { Panel, PanelHeader } from './Panel';
import { ResultViewer } from './ResultViewer';
import { usePlaygroundToken } from './use-token';

type JobStatus = 'running' | 'scraping' | 'completed' | 'failed' | 'cancelled' | string;

interface StatusPayload {
  status?: JobStatus;
  completed?: number;
  total?: number;
  data?: unknown;
  event?: string;
  code?: string;
  error?: string;
  [key: string]: unknown;
}

interface Props {
  jobId: string;
  mode: 'crawl' | 'batch';
  onCleared?: () => void;
}

export function JobStatusPanel({ jobId, mode, onCleared }: Props) {
  const token = usePlaygroundToken();
  const [latest, setLatest] = useState<StatusPayload | null>(null);
  const [streamError, setStreamError] = useState<ApiError | string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token || !jobId) return;

    let cancelled = false;
    const ac = new AbortController();
    abortRef.current = ac;

    const path =
      mode === 'crawl'
        ? `/api/firecrawl/crawl/${encodeURIComponent(jobId)}`
        : `/api/firecrawl/batch-scrape/${encodeURIComponent(jobId)}`;

    if (mode === 'crawl') {
      (async () => {
        try {
          const res = await fetch(path, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            if (!cancelled) setStreamError(body as ApiError);
            return;
          }

          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });

            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const raw = line.slice(5).trim();
                if (!raw) continue;
                try {
                  const parsed = JSON.parse(raw) as StatusPayload;
                  if (parsed.event === 'error') {
                    setStreamError(parsed);
                  } else {
                    setLatest(parsed);
                  }
                } catch {
                  /* ignore malformed frame */
                }
              }
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          if (!cancelled) {
            setStreamError(err instanceof Error ? err.message : 'stream error');
          }
        }
      })();
    } else {
      const tick = async () => {
        try {
          const res = await fetch(path, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
            signal: ac.signal,
          });
          const json = (await res.json().catch(() => ({}))) as StatusPayload;
          if (cancelled) return;
          if (!res.ok) {
            setStreamError(json as ApiError);
            return;
          }
          setLatest(json);
          const s = json.status;
          if (s === 'completed' || s === 'failed' || s === 'cancelled') {
            if (pollTimerRef.current) {
              clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          setStreamError(err instanceof Error ? err.message : 'poll error');
        }
      };
      void tick();
      pollTimerRef.current = setInterval(tick, 2000);
    }

    return () => {
      cancelled = true;
      ac.abort();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [token, jobId, mode]);

  const onCancel = async () => {
    if (!token || mode !== 'crawl') return;
    setCancelling(true);
    try {
      await fetch(`/api/firecrawl/crawl/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } finally {
      setCancelling(false);
      abortRef.current?.abort();
    }
  };

  const status = latest?.status ?? 'running';
  const completed = typeof latest?.completed === 'number' ? latest.completed : 0;
  const total = typeof latest?.total === 'number' ? latest.total : 0;
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const finished = status === 'completed' || status === 'failed' || status === 'cancelled';

  return (
    <div className="flex flex-col gap-16">
      <Panel>
        <PanelHeader
          title="Job status"
          right={
            <div className="flex items-center gap-10">
              {mode === 'crawl' && !finished && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={cancelling}
                  className="inline-flex h-28 items-center gap-6 rounded-6 border border-transparent px-10 text-label-medium font-medium text-accent-crimson transition-colors hover:border-border-muted hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Square className="h-12 w-12" />
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {finished && onCleared && (
                <button
                  type="button"
                  onClick={onCleared}
                  className="inline-flex h-28 items-center rounded-6 border border-border-muted bg-accent-white px-10 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
                >
                  Clear
                </button>
              )}
            </div>
          }
        />

        <div className="px-16 py-16">
          <div className="flex flex-wrap items-center gap-x-20 gap-y-12">
            <div className="flex flex-col gap-4">
              <span className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
                Job ID
              </span>
              <span className="font-mono text-mono-small text-accent-black">{jobId}</span>
            </div>
            <StatusPill status={status} />
            <div className="flex flex-col gap-4">
              <span className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
                Progress
              </span>
              <span className="font-mono text-mono-small tabular-nums text-accent-black">
                {completed.toLocaleString()} / {total.toLocaleString() || '—'}
              </span>
            </div>
            {!finished && (
              <Loader2 className="h-16 w-16 animate-spin text-heat-100" />
            )}
          </div>

          {total > 0 && (
            <div
              className="mt-16 h-6 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'rgba(0, 0, 0, 0.06)' }}
            >
              <div
                className="h-full rounded-full bg-heat-100 transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      </Panel>

      {streamError && <ErrorAlert error={streamError} />}

      {finished && status === 'completed' && latest && (
        <Panel>
          <PanelHeader title="Response" />
          <div className="px-16 pb-16">
            <ResultViewer result={latest} />
          </div>
        </Panel>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  const base =
    'inline-flex items-center gap-6 rounded-full px-10 py-2 text-label-x-small font-medium';

  if (status === 'completed') {
    return (
      <span
        className={`${base} text-accent-forest`}
        style={{ backgroundColor: 'rgba(66, 195, 102, 0.10)' }}
      >
        <span className="block h-6 w-6 rounded-full bg-accent-forest" />
        Completed
      </span>
    );
  }

  if (status === 'failed' || status === 'cancelled') {
    return (
      <span
        className={`${base} text-accent-crimson capitalize`}
        style={{ backgroundColor: 'rgba(235, 52, 36, 0.10)' }}
      >
        <span className="block h-6 w-6 rounded-full bg-accent-crimson" />
        {status}
      </span>
    );
  }

  return (
    <span
      className={`${base} text-accent-bluetron capitalize`}
      style={{ backgroundColor: 'rgba(42, 109, 251, 0.10)' }}
    >
      <span className="block h-6 w-6 animate-pulse rounded-full bg-accent-bluetron" />
      {status}
    </span>
  );
}
