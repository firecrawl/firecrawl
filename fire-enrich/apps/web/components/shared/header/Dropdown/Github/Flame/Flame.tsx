"use client";

import { HTMLAttributes, useEffect, useRef } from "react";

import { cn } from "@/utils/cn";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";

import data from "./data.json";

export default function GithubFlame(attrs: HTMLAttributes<HTMLDivElement>) {
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

        if (!ref.current) return;

        ref.current!.innerHTML = newStr;
      },
      interval: 60,
    });

    return () => interval?.();
  }, []);

  return (
    <div
      className="absolute -top-20 left-180 w-194 h-192"
      style={{
        maskImage: "url('/assets-original/github-mask.png')",
        maskSize: "100% 100%",
      }}
    >
      <div
        ref={wrapperRef}
        {...attrs}
        className={cn(
          "w-308 h-380 -top-20 -left-40 absolute pointer-events-none select-none",
          attrs.className,
        )}
      >
        <div
          className="text-black-alpha-20 relative top-0 left-0 font-ascii fc-decoration"
          ref={ref}
          style={{
            whiteSpace: "pre",
            fontSize: 8,
            lineHeight: "10px",
          }}
        />
      </div>
    </div>
  );
}
