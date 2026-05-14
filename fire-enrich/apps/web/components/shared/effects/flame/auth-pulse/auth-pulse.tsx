"use client";

import { HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";
import data from "./pulse-data.json";

interface AuthPulseProps extends HTMLAttributes<HTMLDivElement> {
  interval?: number;
  opacity?: number;
}

export function AuthPulse({
  interval = 100,
  opacity = 0.15,
  className,
  ...attrs
}: AuthPulseProps) {
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
      <div
        ref={ref}
        className="text-heat-100 absolute inset-0 flex items-center justify-center fc-decoration"
        style={{
          whiteSpace: "pre",
          fontSize: "9px",
          lineHeight: "11px",
          opacity,
        }}
      />
    </div>
  );
}
