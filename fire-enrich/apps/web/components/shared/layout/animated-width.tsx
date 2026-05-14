"use client";

import { motion, TargetAndTransition, Transition } from "motion/react";
import { useEffect, useRef, useState } from "react";

type AnimatedWidthProps = {
  children: React.ReactNode;
  animate?: TargetAndTransition;
  initial?: TargetAndTransition;
  transition?: Transition;
};

export default function AnimatedWidth({
  children,
  ...attrs
}: AnimatedWidthProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [width, setWidth] = useState<number | "auto">("auto");

  useEffect(() => {
    const child = containerRef.current?.children[0] as Element;

    const updateWidth = () => {
      if (!child) return;

      setWidth(child.clientWidth);
    };

    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);

    resizeObserver.observe(child);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <motion.div
      {...attrs}
      animate={{
        width,
        ...attrs.animate,
      }}
      className="overflow-hidden"
      initial={{
        width,
        ...attrs.initial,
      }}
      ref={containerRef}
    >
      <div className="w-max whitespace-nowrap">{children}</div>
    </motion.div>
  );
}
