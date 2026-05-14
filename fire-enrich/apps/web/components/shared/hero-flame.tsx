"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";

// Sample of flame frames - using a subset for performance
const flameFrames = [
  `
       ▄▄▄
      ▄███▄
     ▄█████▄
    ▄███████▄
   ▄█████████▄
  ▄███████████▄
 ▄█████████████▄
▄███████████████▄
█████████████████
███▀▀▀███▀▀▀█████
██     ███    ███
█       ▀      ██
`,
  `
      ▄███▄
     ▄█████▄
    ▄███▀███▄
   ▄████▄████▄
  ▄███████████▄
 ▄█████▀▀██████▄
▄██████▄▄███████▄
█████████████████
███▀▀█████▀▀█████
██    ███     ███
█      ▀       ██

`,
  `
     ▄█████▄
    ▄███████▄
   ▄█████████▄
  ▄███▀███▀███▄
 ▄████▄███▄████▄
▄██████████████▄
████▀▀█████▀▀████
███    ███    ███
██     ▀▀     ███
█             ██


`,
  `
    ▄███████▄
   ▄█████████▄
  ▄███████████▄
 ▄█████▀▀██████▄
▄███████▄▄██████▄
██████████████████
████▀▀▀████▀▀▀████
███     ███    ███
██      ▀▀      ██
█               █


`,
];

interface HeroFlameProps {
  className?: string;
  size?: "small" | "medium" | "large";
}

export function HeroFlame({ className, size = "medium" }: HeroFlameProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % flameFrames.length);
    }, 85);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const sizeClasses = {
    small: "text-[8px] leading-[10px]",
    medium: "text-[12px] leading-[14px]",
    large: "text-[16px] leading-[18px]",
  };

  return (
    <div
      className={cn("flex gap-4 pointer-events-none select-none", className)}
    >
      {/* Left flame */}
      <div className="relative overflow-hidden">
        <pre
          className={cn(
            "text-heat-100 whitespace-pre",
            sizeClasses[size],
          )}
        >
          {flameFrames[frameIndex]}
        </pre>
      </div>

      {/* Right flame (mirrored) */}
      <div className="relative overflow-hidden -scale-x-100">
        <pre
          className={cn(
            "text-heat-100 whitespace-pre",
            sizeClasses[size],
          )}
        >
          {flameFrames[frameIndex]}
        </pre>
      </div>
    </div>
  );
}
