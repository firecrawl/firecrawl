"use client";

import React, { useEffect, useRef } from "react";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";
import data from "./wave-data.json";

export default function SubtleWave({ className = "" }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameIndex = useRef(0);

  useEffect(() => {
    const animateWave = () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = data[frameIndex.current];
        frameIndex.current = (frameIndex.current + 1) % data.length;
      }
    };

    // Initialize first frame
    animateWave();

    // Start animation when visible
    const cleanup = setIntervalOnVisible({
      element: containerRef.current,
      callback: animateWave,
      interval: 150, // Slower for subtlety
    });

    return () => {
      cleanup?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`text-white/10 whitespace-pre select-none fc-decoration ${className}`}
      style={{
        fontSize: "10px",
        lineHeight: "1",
        letterSpacing: "0.05em",
      }}
    />
  );
}
