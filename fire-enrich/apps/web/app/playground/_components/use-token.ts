'use client';

import { useEffect, useState } from 'react';

import { TOKEN_STORAGE_KEY } from '@/components/app/sidebar/TokenDialog';

/**
 * Hook returning the playground bearer token from localStorage. Re-reads on
 * mount, on `storage` events (other tabs), and when the window regains focus
 * (catches updates made via the sidebar dialog in this same tab).
 */
export function usePlaygroundToken(): string | null {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () =>
      setToken(window.localStorage.getItem(TOKEN_STORAGE_KEY));
    read();

    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_STORAGE_KEY) read();
    };
    const onFocus = () => read();

    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return token;
}
