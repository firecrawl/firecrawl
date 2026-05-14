'use client';

import { CircleAlert } from 'lucide-react';

export interface ApiError {
  code?: string;
  error?: string;
  [key: string]: unknown;
}

export function ErrorAlert({ error }: { error: ApiError | string }) {
  const body = typeof error === 'string' ? { error } : error;
  return (
    <div
      role="alert"
      className="flex items-start gap-12 rounded-10 border border-accent-crimson bg-accent-white p-16"
      style={{
        boxShadow: '0 0 0 1px rgba(235, 52, 36, 0.08)',
      }}
    >
      <span className="flex h-32 w-32 shrink-0 items-center justify-center rounded-8 text-accent-crimson"
        style={{ backgroundColor: 'rgba(235, 52, 36, 0.10)' }}
      >
        <CircleAlert className="h-16 w-16" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-6 pt-2">
        <p className="text-body-small font-medium text-accent-crimson">
          Request failed
        </p>
        <pre className="m-0 max-h-200 overflow-auto whitespace-pre-wrap break-all rounded-6 bg-black-alpha-4 p-12 font-mono text-mono-x-small text-accent-black">
          {JSON.stringify(body, null, 2)}
        </pre>
      </div>
    </div>
  );
}
