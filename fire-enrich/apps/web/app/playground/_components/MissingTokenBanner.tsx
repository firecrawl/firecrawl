'use client';

import Link from 'next/link';
import { KeyRound } from 'lucide-react';

export function MissingTokenBanner() {
  return (
    <div
      role="alert"
      className="flex items-start gap-12 rounded-10 border border-border-muted bg-background-lighter p-16"
    >
      <span className="flex h-32 w-32 shrink-0 items-center justify-center rounded-8 bg-heat-12 text-heat-100">
        <KeyRound className="h-16 w-16" />
      </span>
      <div className="flex flex-col gap-4 pt-2">
        <p className="text-body-small font-medium text-accent-black">
          Set your bearer token to run the playground.
        </p>
        <p className="text-body-small text-black-alpha-72">
          Issue one in{' '}
          <Link
            href="/admin/principals"
            className="font-medium text-heat-100 underline decoration-heat-40 underline-offset-2 transition-colors hover:decoration-heat-100"
          >
            /admin/principals
          </Link>
          {' '}then click <span className="font-mono text-mono-small text-accent-black">API token</span> at the bottom of the sidebar.
        </p>
      </div>
    </div>
  );
}
