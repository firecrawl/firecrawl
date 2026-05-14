'use client';

import { Loader2, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import Input from '@/components/ui/input';
import { PrimaryButton } from '@/app/playground/_components/PrimaryButton';

interface LoginErrorBody {
  code?: string;
  error?: string;
}

export function LoginForm() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!token.trim()) {
      setError('Please enter the admin token.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        let msg = `Login failed (${res.status})`;
        try {
          const body = (await res.json()) as LoginErrorBody;
          if (body?.error) msg = body.error;
        } catch {
          /* keep default */
        }
        setError(msg);
        return;
      }

      window.location.assign('/admin/principals');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-24 flex items-center gap-10">
        <span className="block h-12 w-12 rounded-full bg-heat-100 shadow-[0_0_0_3px_var(--heat-12)]" />
        <span className="text-body-small font-semibold tracking-tight text-accent-black">
          Fire Enrich
        </span>
      </div>

      <div className="overflow-hidden rounded-12 border border-border-muted bg-accent-white shadow-[0_24px_64px_-24px_rgba(0,0,0,0.12),0_2px_8px_0_rgba(0,0,0,0.04)]">
        <header className="flex items-start gap-12 border-b border-border-faint px-20 py-16">
          <span className="flex h-32 w-32 shrink-0 items-center justify-center rounded-8 bg-heat-12 text-heat-100">
            <Lock className="h-16 w-16" />
          </span>
          <div className="flex flex-col gap-4">
            <h1 className="text-body-medium font-semibold tracking-tight text-accent-black">
              Admin sign-in
            </h1>
            <p className="text-body-small text-black-alpha-72">
              Enter the admin token to manage principals.
            </p>
          </div>
        </header>

        <form onSubmit={onSubmit} className="flex flex-col gap-16 px-20 py-20">
          <div className="flex flex-col gap-8">
            <label
              htmlFor="admin-token"
              className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56"
            >
              Admin token
            </label>
            <Input
              id="admin-token"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          {error && (
            <p
              role="alert"
              data-slot="login-error"
              className="rounded-8 px-12 py-8 text-body-small text-accent-crimson"
              style={{ backgroundColor: 'rgba(235, 52, 36, 0.08)' }}
            >
              {error}
            </p>
          )}

          <PrimaryButton type="submit" disabled={submitting} className="w-full justify-center">
            {submitting ? (
              <>
                <Loader2 className="h-14 w-14 animate-spin" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </PrimaryButton>
        </form>
      </div>

      <p className="mt-16 text-center text-body-small text-black-alpha-48">
        Token is configured via <span className="font-mono text-mono-x-small text-black-alpha-72">ADMIN_TOKEN</span> in the server env.
      </p>
    </div>
  );
}
