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
  FormInput,
  FormToolbar,
} from '../_components/form-primitives';
import { usePlaygroundToken } from '../_components/use-token';

export function CrawlView() {
  const token = usePlaygroundToken();
  const [url, setUrl] = useState('https://docs.firecrawl.dev');
  const [limit, setLimit] = useState(25);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setJobId(null);

    if (!token) {
      setError('Set your bearer token in the sidebar before starting a crawl.');
      return;
    }
    if (!url.trim()) {
      setError('URL is required.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/firecrawl/crawl', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          url: url.trim(),
          options: { limit },
        }),
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
        title="Crawl"
        subtitle="Spider a site. Status streams over SSE while it runs."
        endpoint="POST /v2/crawl"
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-20">
          {!token && <MissingTokenBanner />}

          <Panel>
            <PanelHeader title="Request" />
            <PanelBody>
              <form onSubmit={onSubmit} className="flex flex-col gap-16">
                <Field id="crawl-url" label="URL">
                  <FormInput
                    id="crawl-url"
                    type="url"
                    placeholder="https://docs.firecrawl.dev"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={submitting}
                    required
                  />
                </Field>
                <Field
                  id="crawl-limit"
                  label="Page limit"
                  hint="Maximum pages to fetch in this crawl. Hard cap is 1000."
                >
                  <FormInput
                    id="crawl-limit"
                    type="number"
                    min={1}
                    max={1000}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value) || 1)}
                    disabled={submitting}
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
                        Start crawl
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
              mode="crawl"
              onCleared={() => setJobId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
