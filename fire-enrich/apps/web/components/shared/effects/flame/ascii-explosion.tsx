"use client";

import { HTMLAttributes, useEffect, useRef } from "react";

import { cn } from "@/utils/cn";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";

import data from "./explosion-data.json";

export function AsciiExplosion(attrs: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let index = -30;

    const interval = setIntervalOnVisible({
      element: wrapperRef.current,
      callback: () => {
        index++;
        if (index >= data.length) index = -40;
        if (index < 0) return;

        ref.current!.innerHTML = data[index];
      },
      interval: 40,
    });

    return () => interval?.();
  }, []);

  return (
    <div
      ref={wrapperRef}
      {...attrs}
      className={cn(
        "w-[720px] h-[400px] absolute flex gap-16 pointer-events-none select-none",
        attrs.className,
      )}
    >
      <div
        className="text-[#FA5D19] fc-decoration"
        dangerouslySetInnerHTML={{ __html: data[0] }}
        ref={ref}
        style={{
          whiteSpace: "pre",
          fontSize: "10px",
          lineHeight: "12.5px",
        }}
      />
    </div>
  );
}

// Default export for backward compatibility
export default AsciiExplosion;
