'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import copy from 'copy-to-clipboard';
import { Check, Copy, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import Input from '@/components/ui/input';
import { PrimaryButton } from '@/app/playground/_components/PrimaryButton';
import type { PrincipalSummary } from '@/lib/admin-types';

interface CreateResponse {
  principal: PrincipalSummary;
  plaintextToken: string;
}

interface ErrorBody {
  code?: string;
  error?: string;
}

const fieldLabelCls =
  'text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56';
const ghostButtonCls =
  'inline-flex h-32 items-center rounded-8 border border-border-muted bg-accent-white px-12 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40 disabled:cursor-not-allowed disabled:opacity-60';

export function NewPrincipalDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [label, setLabel] = useState('');
  const [byokFirecrawl, setByokFirecrawl] = useState('');
  const [byokOpenai, setByokOpenai] = useState('');
  const [quotaFirecrawl, setQuotaFirecrawl] = useState('');
  const [quotaOpenai, setQuotaOpenai] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setLabel('');
    setByokFirecrawl('');
    setByokOpenai('');
    setQuotaFirecrawl('');
    setQuotaOpenai('');
    setSubmitting(false);
    setError(null);
    setCreated(null);
    setCopied(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (created && next === false) return;
    if (!next) reset();
    setOpen(next);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError('Label is required.');
      return;
    }

    const body: Record<string, unknown> = { label: label.trim() };
    if (byokFirecrawl.trim()) body.byokFirecrawlKey = byokFirecrawl.trim();
    if (byokOpenai.trim()) body.byokOpenaiKey = byokOpenai.trim();
    if (quotaFirecrawl.trim()) {
      const n = Number(quotaFirecrawl);
      if (!Number.isInteger(n) || n <= 0) {
        setError('Firecrawl quota must be a positive integer.');
        return;
      }
      body.quotaFirecrawlMonth = { limit: n };
    }
    if (quotaOpenai.trim()) {
      const n = Number(quotaOpenai);
      if (!Number.isInteger(n) || n <= 0) {
        setError('OpenAI quota must be a positive integer.');
        return;
      }
      body.quotaOpenaiMonth = { limit: n };
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/principals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `Create failed (${res.status})`;
        try {
          const eb = (await res.json()) as ErrorBody;
          if (eb?.error) msg = eb.error;
        } catch {
          /* keep default */
        }
        setError(msg);
        return;
      }
      const json = (await res.json()) as CreateResponse;
      setCreated(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const onCopy = () => {
    if (!created) return;
    const ok = copy(created.plaintextToken);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const onAcknowledge = () => {
    setOpen(false);
    reset();
    router.refresh();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <PrimaryButton type="button">
          <Plus className="h-14 w-14" />
          New principal
        </PrimaryButton>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'rgba(15, 16, 20, 0.40)', backdropFilter: 'blur(2px)' }}
        />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-12 border border-border-muted bg-accent-white shadow-[0_24px_64px_-16px_rgba(0,0,0,0.24),0_2px_8px_0_rgba(0,0,0,0.08)] focus:outline-none"
          onEscapeKeyDown={created ? (e) => e.preventDefault() : undefined}
          onPointerDownOutside={created ? (e) => e.preventDefault() : undefined}
          onInteractOutside={created ? (e) => e.preventDefault() : undefined}
        >
          {created ? (
            <RevealPanel
              created={created}
              copied={copied}
              onCopy={onCopy}
              onAcknowledge={onAcknowledge}
            />
          ) : (
            <CreateForm
              label={label}
              setLabel={setLabel}
              byokFirecrawl={byokFirecrawl}
              setByokFirecrawl={setByokFirecrawl}
              byokOpenai={byokOpenai}
              setByokOpenai={setByokOpenai}
              quotaFirecrawl={quotaFirecrawl}
              setQuotaFirecrawl={setQuotaFirecrawl}
              quotaOpenai={quotaOpenai}
              setQuotaOpenai={setQuotaOpenai}
              submitting={submitting}
              error={error}
              onSubmit={onSubmit}
              onCancel={() => handleOpenChange(false)}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface CreateFormProps {
  label: string;
  setLabel: (s: string) => void;
  byokFirecrawl: string;
  setByokFirecrawl: (s: string) => void;
  byokOpenai: string;
  setByokOpenai: (s: string) => void;
  quotaFirecrawl: string;
  setQuotaFirecrawl: (s: string) => void;
  quotaOpenai: string;
  setQuotaOpenai: (s: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

function CreateForm({
  label,
  setLabel,
  byokFirecrawl,
  setByokFirecrawl,
  byokOpenai,
  setByokOpenai,
  quotaFirecrawl,
  setQuotaFirecrawl,
  quotaOpenai,
  setQuotaOpenai,
  submitting,
  error,
  onSubmit,
  onCancel,
}: CreateFormProps) {
  return (
    <>
      <header className="flex items-start justify-between gap-12 border-b border-border-faint px-20 py-16">
        <div className="flex flex-col gap-4">
          <DialogPrimitive.Title className="text-body-medium font-semibold tracking-tight text-accent-black">
            Create principal
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-body-small text-black-alpha-72">
            Provision a new bearer token. BYOK keys are stored encrypted; quotas only apply to pooled keys.
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close
          className="-m-4 flex h-28 w-28 shrink-0 items-center justify-center rounded-6 text-black-alpha-56 transition-colors hover:bg-black-alpha-5 hover:text-accent-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
          aria-label="Close"
        >
          <X className="h-16 w-16" />
        </DialogPrimitive.Close>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-16 px-20 py-20">
        <div className="flex flex-col gap-8">
          <label htmlFor="np-label" className={fieldLabelCls}>
            Label
          </label>
          <Input
            id="np-label"
            placeholder="e.g. Alice CRM"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={submitting}
            required
            autoFocus
          />
        </div>

        <fieldset className="flex flex-col gap-12 rounded-10 border border-border-faint bg-background-lighter p-16">
          <legend className="px-6 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
            BYOK overrides
            <span className="ml-6 normal-case tracking-normal text-black-alpha-48">
              optional
            </span>
          </legend>
          <div className="flex flex-col gap-8">
            <label htmlFor="np-byok-fc" className="text-body-small text-black-alpha-72">
              Firecrawl key
            </label>
            <Input
              id="np-byok-fc"
              type="password"
              placeholder="fc-…"
              value={byokFirecrawl}
              onChange={(e) => setByokFirecrawl(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-8">
            <label htmlFor="np-byok-oai" className="text-body-small text-black-alpha-72">
              OpenAI key
            </label>
            <Input
              id="np-byok-oai"
              type="password"
              placeholder="sk-…"
              value={byokOpenai}
              onChange={(e) => setByokOpenai(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-12">
          <div className="flex flex-col gap-8">
            <label htmlFor="np-quota-fc" className={fieldLabelCls}>
              Firecrawl / month
            </label>
            <Input
              id="np-quota-fc"
              type="number"
              min={1}
              placeholder="1000"
              value={quotaFirecrawl}
              onChange={(e) => setQuotaFirecrawl(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-8">
            <label htmlFor="np-quota-oai" className={fieldLabelCls}>
              OpenAI / month
            </label>
            <Input
              id="np-quota-oai"
              type="number"
              min={1}
              placeholder="5000"
              value={quotaOpenai}
              onChange={(e) => setQuotaOpenai(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-8 px-12 py-8 text-body-small text-accent-crimson"
            style={{ backgroundColor: 'rgba(235, 52, 36, 0.08)' }}
          >
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-8 border-t border-border-faint pt-16">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={ghostButtonCls}
          >
            Cancel
          </button>
          <PrimaryButton type="submit" disabled={submitting} className="h-32 px-14">
            {submitting ? 'Creating…' : 'Create principal'}
          </PrimaryButton>
        </div>
      </form>
    </>
  );
}

function RevealPanel({
  created,
  copied,
  onCopy,
  onAcknowledge,
}: {
  created: CreateResponse;
  copied: boolean;
  onCopy: () => void;
  onAcknowledge: () => void;
}) {
  return (
    <>
      <header className="flex items-start gap-12 border-b border-border-faint px-20 py-16">
        <span className="flex h-32 w-32 shrink-0 items-center justify-center rounded-8 bg-heat-12 text-heat-100">
          <Check className="h-16 w-16" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <DialogPrimitive.Title className="text-body-medium font-semibold tracking-tight text-accent-black">
            Token created
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-body-small text-black-alpha-72">
            Copy this token now. It is shown <span className="font-medium text-accent-crimson">once</span> and cannot be recovered.
          </DialogPrimitive.Description>
        </div>
      </header>

      <div className="flex flex-col gap-12 px-20 py-20">
        <div className="flex items-center gap-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
          <span>{created.principal.label}</span>
          <span className="text-black-alpha-32">·</span>
          <span className="font-mono normal-case tracking-normal">{created.principal.tokenPrefix}</span>
        </div>

        <code
          className="block max-h-200 overflow-auto break-all rounded-8 border border-border-muted bg-background-lighter p-12 font-mono text-mono-small text-accent-black select-all"
          data-slot="plaintext-token"
        >
          {created.plaintextToken}
        </code>

        <div className="flex items-center justify-between gap-12">
          <button
            type="button"
            onClick={onCopy}
            className={ghostButtonCls}
          >
            {copied ? (
              <>
                <Check className="mr-6 h-14 w-14 text-accent-forest" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-6 h-14 w-14" />
                Copy token
              </>
            )}
          </button>
          <p
            role="status"
            aria-live="polite"
            className="text-body-small text-black-alpha-56"
          >
            {copied ? 'In clipboard.' : 'One-time reveal.'}
          </p>
        </div>
      </div>

      <footer className="flex items-center justify-end gap-8 border-t border-border-faint px-20 py-16">
        <PrimaryButton type="button" onClick={onAcknowledge} className="h-32 px-14">
          I have copied the token
        </PrimaryButton>
      </footer>
    </>
  );
}
