// @ts-nocheck

import { useEffect, useRef } from "react";

const DEFAULT_CONFIG = {
  timeout: 0,
  ignoreInitialCall: true,
};

export function useDebouncedEffect(
  callback: () => void | (() => void),
  config:
    | number
    | {
        timeout?: number;
        ignoreInitialCall?: boolean;
      },
  deps: any[] = [],
): void {
  let currentConfig;

  if (typeof config === "object") {
    currentConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  } else {
    currentConfig = {
      ...DEFAULT_CONFIG,
      timeout: config,
    };
  }
  const { timeout, ignoreInitialCall } = currentConfig;

  const data = useRef<{ firstTime: boolean }>({ firstTime: true });

  useEffect(() => {
    const { firstTime } = data.current;

    if (firstTime && ignoreInitialCall) {
      data.current.firstTime = false;

      return;
    }

    let clearFunc: (() => void) | undefined;

    const handler = setTimeout(() => {
      clearFunc = callback() ?? undefined;
    }, timeout);

    return () => {
      clearTimeout(handler);

      if (clearFunc && typeof clearFunc === "function") {
        clearFunc();
      }
    };
  }, [
    callback,
    ignoreInitialCall,
    timeout,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...deps,
  ]);
}

export default useDebouncedEffect;
