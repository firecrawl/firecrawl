"use client";

import React, { useRef, useEffect, ReactNode, useState } from "react";

// Smoothly animates its container to match the natural height of its content.
// Fixes previous behavior where the component observed itself, causing height 0
// with overflow hidden (content clipped) or visible overflow that overlapped
// following sections like the footer.
export default function AnimatedHeight({
  children,
  overflow = true,
}: {
  children: ReactNode;
  overflow?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const hasAnimatedOnceRef = useRef(false);

  useEffect(() => {
    const contentEl = contentRef.current;
    const containerEl = containerRef.current;
    if (!contentEl || !containerEl) return;

    const updateHeight = () => {
      // Use scrollHeight to capture full natural height, including overflowed content
      const height = contentEl.scrollHeight;
      setMeasuredHeight((prev) => (prev === height ? prev : height));

      // Enable transition after the first measurement to avoid initial jank
      if (!hasAnimatedOnceRef.current) {
        containerEl.style.transition = "height 300ms ease-in-out";
        hasAnimatedOnceRef.current = true;
      }
    };

    // Initial measure
    updateHeight();

    const resizeObserver = new ResizeObserver(() => updateHeight());
    resizeObserver.observe(contentEl);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        overflow: overflow ? "hidden" : "visible",
        height: measuredHeight === null ? undefined : `${measuredHeight}px`,
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
