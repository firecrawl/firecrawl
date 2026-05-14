import {
  useCallback, useRef
} from 'react';

const DEFAULT_CONFIG = { timeout: 0 };

export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  config: number | { timeout?: number }
): T {
  const timeoutRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const currentConfig = typeof config === 'object' ? {
    ...DEFAULT_CONFIG,
    ...config
  } : {
    ...DEFAULT_CONFIG,
    timeout: config
  };

  return useCallback((...args: Parameters<T>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      callbackRef.current(...args);
    }, currentConfig.timeout);
  }, [currentConfig.timeout]) as T;
}

export default useDebouncedCallback;
