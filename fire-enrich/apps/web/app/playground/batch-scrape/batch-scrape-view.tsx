'use client';

import { Loader2, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ErrorAlert, type ApiError } from '../_components/ErrorAlert';
import { JobStatusPanel } from '../_components/JobStatusPanel';
import { MissingTokenBanner } from '../_components/MissingTokenBanner';
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

export function BatchScrapeView() {
  const token = usePlaygroundToken();
  const [urlsRaw, setUrlsRaw] = useState(
    'https://example.com\nhttps://docs.firecrawl.dev',
  );
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);

  const urlCount = parseUrls(urlsRaw).length;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setJobId(null);

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
    try {
      const res = await fetch('/api/firecrawl/batch-scrape', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ urls }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json as ApiError);
        return;
      }
      const id = (json as { jobId?: string }).jobId;
      if (!id) {
        setError({ error: 'No jobId in response', raw: json } as ApiError);
        return;
      }
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="Batch scrape"
        subtitle="Run many scrapes in a single async job. Status polls every 2 s."
        endpoint="POST /v2/batch-scrape"
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
                </span>
              }
            />
            <PanelBody>
              <form onSubmit={onSubmit} className="flex flex-col gap-16">
                <Field
                  id="batch-urls"
                  label="URLs"
                  hint="One URL per line."
                >
                  <FormTextarea
                    id="batch-urls"
                    rows={8}
                    value={urlsRaw}
                    onChange={(e) => setUrlsRaw(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </Field>

                <FormToolbar status={<AuthStatus token={token} />}>
                  <PrimaryButton type="submit" disabled={submitting || !token}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-14 w-14 animate-spin" />
                        Starting…
                      </>
                    ) : (
                      <>
                        <Play className="h-14 w-14" />
                        Start batch scrape
                      </>
                    )}
                  </PrimaryButton>
                </FormToolbar>
              </form>
            </PanelBody>
          </Panel>

          {error && <ErrorAlert error={error} />}

          {jobId && (
            <JobStatusPanel
              jobId={jobId}
              mode="batch"
              onCleared={() => setJobId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
