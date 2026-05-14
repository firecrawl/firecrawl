"use client";

import React, { useEffect, useRef } from "react";
import { setIntervalOnVisible } from "@/utils/set-timeout-on-visible";

export default function SubtleAsciiAnimation({
  className = "",
}: {
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Simple ASCII pattern for subtle animation
  const asciiFrames = [
    "░░░░░░░░░░░░░░░░",
    "▒░░░░░░░░░░░░░░░",
    "▒▒░░░░░░░░░░░░░░",
    "░▒▒░░░░░░░░░░░░░",
    "░░▒▒░░░░░░░░░░░░",
    "░░░▒▒░░░░░░░░░░░",
    "░░░░▒▒░░░░░░░░░░",
    "░░░░░▒▒░░░░░░░░░",
    "░░░░░░▒▒░░░░░░░░",
    "░░░░░░░▒▒░░░░░░░",
    "░░░░░░░░▒▒░░░░░░",
    "░░░░░░░░░▒▒░░░░░",
    "░░░░░░░░░░▒▒░░░░",
    "░░░░░░░░░░░▒▒░░░",
    "░░░░░░░░░░░░▒▒░░",
    "░░░░░░░░░░░░░▒▒░",
    "░░░░░░░░░░░░░░▒▒",
    "░░░░░░░░░░░░░░░▒",
  ];

  useEffect(() => {
    let frameIndex = 0;

    const animateAscii = () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = asciiFrames[frameIndex];
        frameIndex = (frameIndex + 1) % asciiFrames.length;
      }
    };

    // Initialize first frame
    animateAscii();

    // Start animation when visible
    const cleanup = setIntervalOnVisible({
      element: containerRef.current,
      callback: animateAscii,
      interval: 150, // Slightly slower for subtlety
    });

    return () => {
      cleanup?.();
    };
  });

  return (
    <div
      ref={containerRef}
      className={`text-white/20 whitespace-pre select-none ${className}`}
      style={{
        fontSize: "10px",
        lineHeight: "1",
        letterSpacing: "0.05em",
      }}
    />
  );
}
