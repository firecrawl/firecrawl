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
  FormInput,
  FormToolbar,
} from '../_components/form-primitives';
import { usePlaygroundToken } from '../_components/use-token';

export function MapView() {
  const token = usePlaygroundToken();
  const [url, setUrl] = useState('https://docs.firecrawl.dev');
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
    if (!url.trim()) {
      setError('URL is required.');
      return;
    }

    setSubmitting(true);
    const startedAt = performance.now();
    try {
      const res = await fetch('/api/firecrawl/map', {
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
        title="Map"
        subtitle="Discover every URL reachable from a site."
        endpoint="POST /v2/map"
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
                <Field id="map-url" label="URL">
                  <FormInput
                    id="map-url"
                    type="url"
                    placeholder="https://docs.firecrawl.dev"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </Field>

                <FormToolbar status={<AuthStatus token={token} />}>
                  <PrimaryButton type="submit" disabled={submitting || !token}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-14 w-14 animate-spin" />
                        Mapping…
                      </>
                    ) : (
                      <>
                        <Play className="h-14 w-14" />
                        Run map
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
