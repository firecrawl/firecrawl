"use client";

import { HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";
import data from "./core-flame.json";

export function CoreFlame(attrs: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let index = 0;

    const interval = setIntervalOnVisible({
      element: wrapperRef.current,
      callback: () => {
        index++;
        if (index >= data.length) index = 0;

        const newStr = data[index];

        ref.current!.innerHTML = newStr;
      },
      interval: 80,
    });

    return () => interval?.();
  }, []);

  return (
    <>
      <div className="absolute inset-10 -z-[10] overflow-clip">
        <div
          ref={wrapperRef}
          {...attrs}
          className={cn(
            "cw-[1110px] ch-470 absolute pointer-events-none select-none",
            attrs.className,
          )}
        >
          <div
            className="text-black-alpha-20 relative left-0 font-ascii"
            ref={ref}
            style={{
              whiteSpace: "pre",
              fontSize: 8,
              lineHeight: "10px",
            }}
          />
        </div>
      </div>
    </>
  );
}

// Export default for backward compatibility
export default CoreFlame;
