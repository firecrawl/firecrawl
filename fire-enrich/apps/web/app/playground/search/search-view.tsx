'use client';

import { Loader2, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ErrorAlert, type ApiError } from '../_components/ErrorAlert';
import { MissingTokenBanner } from '../_components/MissingTokenBanner';
import { ResultViewer } from '../_components/ResultViewer';
import { PageHeader } from '../_components/PageHeader';
import { Panel, PanelBody, PanelHeader } from '../_components/Panel';
import { PrimaryButton } from '../_components/PrimaryButton';
import {
  AuthStatus,
  Field,
  FormCheckbox,
  FormInput,
  FormToolbar,
} from '../_components/form-primitives';
import { usePlaygroundToken } from '../_components/use-token';

export function SearchView() {
  const token = usePlaygroundToken();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [scrapeContent, setScrapeContent] = useState(false);
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
      setError('Set your bearer token in the sidebar first.');
      return;
    }
    if (!query.trim()) {
      setError('Query is required.');
      return;
    }

    setSubmitting(true);
    const startedAt = performance.now();
    try {
      const res = await fetch('/api/firecrawl/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: query.trim(),
          limit,
          scrapeContent,
        }),
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
        title="Search"
        subtitle="Web search. Optionally scrape each result page."
        endpoint="POST /v2/search"
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
                <Field id="search-q" label="Query">
                  <FormInput
                    id="search-q"
                    placeholder="firecrawl docs"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </Field>
                <Field id="search-limit" label="Result limit">
                  <FormInput
                    id="search-limit"
                    type="number"
                    min={1}
                    max={50}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value) || 1)}
                    disabled={submitting}
                  />
                </Field>

                <FormCheckbox
                  id="search-scrape"
                  checked={scrapeContent}
                  onChange={setScrapeContent}
                  disabled={submitting}
                  label="Scrape each result"
                  hint="Adds the page markdown to every hit. Slower, but useful for snippets."
                />

                <FormToolbar status={<AuthStatus token={token} />}>
                  <PrimaryButton type="submit" disabled={submitting || !token}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-14 w-14 animate-spin" />
                        Searching…
                      </>
                    ) : (
                      <>
                        <Play className="h-14 w-14" />
                        Run search
                      </>
                    )}
                  </PrimaryButton>
                </FormToolbar>
              </form>
            </PanelBody>
          </Panel>

          {error && <ErrorAlert error={error} />}

          {result !== null && (
            <Panel>
              <PanelHeader
                title="Response"
                right={
                  elapsedMs !== null && (
                    <span className="font-mono text-mono-small text-black-alpha-56">
                      {elapsedMs} ms
                    </span>
                  )
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
