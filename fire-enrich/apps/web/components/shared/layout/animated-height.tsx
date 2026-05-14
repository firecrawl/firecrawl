"use client";

import { motion, MotionProps, TargetAndTransition } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/utils/cn";

type AnimatedHeight = {
  children: React.ReactNode;
  animate?: TargetAndTransition;
  initial?: TargetAndTransition;
  exit?: TargetAndTransition;
  className?: string;
  transition?: MotionProps["transition"];
};

export default function AnimatedHeight({ children, ...attrs }: AnimatedHeight) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState<number | "auto">("auto");

  useEffect(() => {
    const child = containerRef.current?.children[0] as Element;

    const updateHeight = () => {
      if (!child) return;

      setHeight(child.clientHeight);
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);

    resizeObserver.observe(child);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <motion.div
      {...attrs}
      animate={{
        height,
        ...attrs.animate,
      }}
      className={cn(attrs.className)}
      initial={{
        height,
        ...attrs.initial,
      }}
      ref={containerRef}
    >
      <div className="h-max">{children}</div>
    </motion.div>
  );
}
