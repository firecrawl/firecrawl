"use client";

import { HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";
import data from "./grid-data.json";

interface SlateGridProps extends HTMLAttributes<HTMLDivElement> {
  interval?: number;
  color?: string;
}

export function SlateGrid({
  interval = 200,
  color = "text-black-alpha-12",
  className,
  ...attrs
}: SlateGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameIndex = useRef(0);

  useEffect(() => {
    const animate = () => {
      if (ref.current) {
        ref.current.innerHTML = data[frameIndex.current];
        frameIndex.current = (frameIndex.current + 1) % data.length;
      }
    };

    // Initialize first frame
    animate();

    const cleanup = setIntervalOnVisible({
      element: wrapperRef.current,
      callback: animate,
      interval,
    });

    return () => cleanup?.();
  }, [interval]);

  return (
    <div
      ref={wrapperRef}
      {...attrs}
      className={cn(
        "absolute inset-0 pointer-events-none select-none overflow-hidden",
        className,
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={ref}
          className={cn("fc-decoration", color)}
          style={{
            whiteSpace: "pre",
            fontSize: "10px",
            lineHeight: "12px",
          }}
        />
      </div>
    </div>
  );
}
