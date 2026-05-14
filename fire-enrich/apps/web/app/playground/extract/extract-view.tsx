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
  FormTextarea,
  FormToolbar,
} from '../_components/form-primitives';
import { usePlaygroundToken } from '../_components/use-token';

function parseUrls(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ExtractView() {
  const token = usePlaygroundToken();
  const [urlsRaw, setUrlsRaw] = useState('https://example.com');
  const [prompt, setPrompt] = useState(
    'Extract the page title and a one-sentence summary.',
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const urlCount = parseUrls(urlsRaw).length;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setElapsedMs(null);

    if (!token) {
      setError('Set your bearer token in the sidebar first.');
      return;
    }
    const urls = parseUrls(urlsRaw);
    if (urls.length === 0) {
      setError('Provide at least one URL (one per line).');
      return;
    }

    setSubmitting(true);
    const startedAt = performance.now();
    try {
      const res = await fetch('/api/firecrawl/extract', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          urls,
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
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
        title="Extract"
        subtitle="Pull structured data from one or more URLs with a natural-language prompt."
        endpoint="POST /v2/extract"
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-20">
          {!token && <MissingTokenBanner />}

          <Panel>
            <PanelHeader
              title="Request"
              right={
                <span className="font-mono text-mono-small text-black-alpha-56">
                  {urlCount} {urlCount === 1 ? 'URL' : 'URLs'}
                  {elapsedMs !== null && <> · {elapsedMs} ms</>}
                </span>
              }
            />
            <PanelBody>
              <form onSubmit={onSubmit} className="flex flex-col gap-16">
                <Field
                  id="extract-urls"
                  label="URLs"
                  hint="One URL per line. Each is fetched and passed to the prompt."
                >
                  <FormTextarea
                    id="extract-urls"
                    rows={5}
                    value={urlsRaw}
                    onChange={(e) => setUrlsRaw(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </Field>
                <Field
                  id="extract-prompt"
                  label="Prompt"
                  hint="Optional. Tells the extractor what fields to return."
                >
                  <FormTextarea
                    id="extract-prompt"
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={submitting}
                  />
                </Field>

                <FormToolbar status={<AuthStatus token={token} />}>
                  <PrimaryButton type="submit" disabled={submitting || !token}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-14 w-14 animate-spin" />
                        Extracting…
                      </>
                    ) : (
                      <>
                        <Play className="h-14 w-14" />
                        Run extract
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
