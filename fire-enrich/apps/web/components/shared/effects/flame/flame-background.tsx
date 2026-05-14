"use client";

import React from "react";
import { cn } from "@/utils/cn";
import { CoreFlame } from "./core-flame";

interface FlameBackgroundProps {
  intensity?: number; // 0-100, like CPU usage
  animate?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function FlameBackground({
  intensity = 0,
  animate = false,
  className,
  children,
}: FlameBackgroundProps) {
  // Convert 0-100 to 0-0.3 opacity
  const opacity = Math.min((intensity / 100) * 0.3, 0.3);

  // Speed increases with intensity
  const speed = Math.max(80 - (intensity / 100) * 40, 40);

  // Color gets more orange with intensity
  const color =
    intensity > 80 ? "heat-100" : intensity > 50 ? "heat-40" : "black-alpha-20";

  return (
    <div className={cn("relative", className)}>
      <CoreFlame
        className={cn(
          "transition-opacity duration-1000",
          animate && "animate-pulse",
        )}
      />
      {children && <div className="relative z-10">{children}</div>}
    </div>
  );
}
