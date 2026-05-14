'use client';

import { Loader2, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import Input from '@/components/ui/input';

import { ErrorAlert, type ApiError } from '../_components/ErrorAlert';
import { MissingTokenBanner } from '../_components/MissingTokenBanner';
import { ResultViewer } from '../_components/ResultViewer';
import { usePlaygroundToken } from '../_components/use-token';
import { PageHeader } from '../_components/PageHeader';
import { PrimaryButton } from '../_components/PrimaryButton';
import { Panel, PanelHeader, PanelBody } from '../_components/Panel';

export function ScrapeView() {
  const token = usePlaygroundToken();
  const [url, setUrl] = useState('https://example.com');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setElapsedMs(null);

    if (!token) {
      setError('Set your bearer token in the sidebar before running a scrape.');
      return;
    }
    if (!url.trim()) {
      setError('URL is required.');
      return;
    }

    setSubmitting(true);
    const startedAt = performance.now();
    try {
      const res = await fetch('/api/firecrawl/scrape', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: url.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json as ApiError);
        return;
      }
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setElapsedMs(Math.round(performance.now() - startedAt));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="Scrape"
        subtitle="Fetch a single URL and return its markdown, HTML, and metadata."
        endpoint="POST /v2/scrape"
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-20">
          {!token && <MissingTokenBanner />}

          <Panel>
            <PanelHeader
              title="Request"
              right={
                elapsedMs !== null ? (
                  <span className="font-mono text-mono-small text-black-alpha-56">
                    {elapsedMs} ms
                  </span>
                ) : null
              }
            />
            <PanelBody>
              <form onSubmit={onSubmit} className="flex flex-col gap-16">
                <div className="flex flex-col gap-6">
                  <label
                    htmlFor="scrape-url"
                    className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56"
                  >
                    URL
                  </label>
                  <Input
                    id="scrape-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </div>

                <div className="flex items-center justify-between gap-12 border-t border-border-faint pt-16">
                  <p className="text-body-small text-black-alpha-56">
                    {token ? (
                      <>
                        Authenticated as{' '}
                        <span className="font-mono text-mono-small text-accent-black">
                          {token.slice(0, 12)}…
                        </span>
                      </>
                    ) : (
                      'No token set.'
                    )}
                  </p>
                  <PrimaryButton type="submit" disabled={submitting || !token}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-14 w-14 animate-spin" />
                        Running…
                      </>
                    ) : (
                      <>
                        <Play className="h-14 w-14" />
                        Run scrape
                      </>
                    )}
                  </PrimaryButton>
                </div>
              </form>
            </PanelBody>
          </Panel>

          {error && <ErrorAlert error={error} />}

          {result !== null && (
            <Panel>
              <PanelHeader
                title="Response"
                right={
                  <span className="flex items-center gap-10">
                    <span
                      className="inline-flex items-center gap-6 rounded-full border border-border-muted px-8 py-2 text-label-x-small font-medium text-accent-forest"
                      style={{ backgroundColor: 'rgba(66, 195, 102, 0.08)' }}
                    >
                      <span className="block h-6 w-6 rounded-full bg-accent-forest" />
                      200 OK
                    </span>
                    {elapsedMs !== null && (
                      <span className="font-mono text-mono-small text-black-alpha-56">
                        {elapsedMs} ms
                      </span>
                    )}
                  </span>
                }
              />
              <div className="px-16 pb-16">
                <ResultViewer result={result} />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
