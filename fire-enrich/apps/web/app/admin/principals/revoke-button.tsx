'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';

import { revokePrincipalAction } from './actions';

interface Props {
  id: string;
  label: string;
}

export function RevokeButton({ id, label }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Revoke principal "${label}"? This cannot be undone.`)
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await revokePrincipalAction(id);
      if (!res.ok) {
        setError(res.error ?? 'revoke failed');
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-4">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-28 items-center gap-6 rounded-6 border border-transparent px-10 text-label-medium font-medium text-accent-crimson transition-colors hover:border-border-muted hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? (
          <>
            <Loader2 className="h-12 w-12 animate-spin" />
            Revoking…
          </>
        ) : (
          'Revoke'
        )}
      </button>
      {error && (
        <span role="alert" className="text-mono-x-small text-accent-crimson">
          {error}
        </span>
      )}
    </div>
  );
}
