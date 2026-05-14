'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { KeyRound, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import Input from '@/components/ui/input';
import { PrimaryButton } from '@/app/playground/_components/PrimaryButton';

export const TOKEN_STORAGE_KEY = 'fe-playground-token';

interface TokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (token: string | null) => void;
}

export function TokenDialog({ open, onOpenChange, onSaved }: TokenDialogProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    const existing = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
    setValue(existing);
  }, [open]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      const trimmed = value.trim();
      if (trimmed) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
        onSaved?.(trimmed);
      } else {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        onSaved?.(null);
      }
    }
    onOpenChange(false);
  };

  const onClear = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      onSaved?.(null);
    }
    setValue('');
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'rgba(15, 16, 20, 0.40)', backdropFilter: 'blur(2px)' }}
        />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-12 border border-border-muted bg-accent-white shadow-[0_24px_64px_-16px_rgba(0,0,0,0.24),0_2px_8px_0_rgba(0,0,0,0.08)] focus:outline-none"
        >
          <header className="flex items-start gap-12 border-b border-border-faint px-20 py-16">
            <span className="flex h-32 w-32 shrink-0 items-center justify-center rounded-8 bg-heat-12 text-heat-100">
              <KeyRound className="h-16 w-16" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <DialogPrimitive.Title className="text-body-medium font-semibold tracking-tight text-accent-black">
                API token
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-body-small text-black-alpha-72">
                Paste a bearer token issued from{' '}
                <span className="font-mono text-mono-small text-accent-black">/admin/principals</span>.
                Stored in this browser only.
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
              <label
                htmlFor="fe-token-input"
                className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56"
              >
                Bearer token
              </label>
              <Input
                id="fe-token-input"
                type="password"
                placeholder="fe_…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-body-small text-black-alpha-56">
                Sent as <span className="font-mono text-mono-x-small text-accent-black">Authorization: Bearer &lt;token&gt;</span> on every playground request.
              </p>
            </div>

            <div className="flex items-center justify-between gap-8 border-t border-border-faint pt-16">
              <button
                type="button"
                onClick={onClear}
                className="inline-flex h-32 items-center rounded-8 px-12 text-label-medium font-medium text-accent-crimson transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
              >
                Clear token
              </button>
              <div className="flex items-center gap-8">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="inline-flex h-32 items-center rounded-8 border border-border-muted bg-accent-white px-12 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
                >
                  Cancel
                </button>
                <PrimaryButton type="submit" className="h-32 px-14">
                  Save token
                </PrimaryButton>
              </div>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
