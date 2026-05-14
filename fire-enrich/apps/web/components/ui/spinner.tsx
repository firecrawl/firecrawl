import { HTMLAttributes, memo, useEffect, useRef } from "react";

import { animate } from "motion";
import { AnimatePresence, motion } from "motion/react";

import Check from "@/components/shared/icons/check";
import { cn } from "@/utils/cn";

export default memo(function Spinner({
  finished,
  ...attrs
}: HTMLAttributes<HTMLDivElement> & { finished?: boolean }) {
  return (
    <div
      {...attrs}
      className={cn("size-20 min-w-[20px] relative", attrs.className)}
    >
      <AnimatePresence initial={false}>
        {!finished && <Canvas />}
      </AnimatePresence>

      {finished && (
        <motion.div
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          className="overlay"
          initial={{ opacity: 0, scale: 0.9, filter: "blur(4px)" }}
          transition={{
            type: "spring",
            stiffness: 100,
            damping: 20,
            delay: 0.2,
          }}
        >
          <Check />
        </motion.div>
      )}
    </div>
  );
});

const Canvas = memo(function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) return;

    // Initialize canvas
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 20 * dpr;
    canvas.height = 20 * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let activeGroup = -1;
    const rects = Array.from({ length: 16 }, (_, i) => ({
      x: 3 + (i % 4) * 4,
      y: 3 + Math.floor(i / 4) * 4,
      width: 2,
      height: 2,
      alpha: 0,
      borderRadius: 0,
    }));

    let dead = false;

    const grid = [
      [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0],
      [0, 1, 1, 0, 1, 0.2, 0.2, 1, 1, 0.2, 0.2, 1, 0, 1, 1, 0],
      [
        1, 0.4, 0.4, 1, 0.4, 0.12, 0.12, 0.4, 0.4, 0.12, 0.12, 0.4, 1, 0.4, 0.4,
        1,
      ],
      [
        0.4, 0.12, 0.12, 0.4, 0.12, 0.04, 0.04, 0.12, 0.12, 0.04, 0.04, 0.12,
        0.4, 0.12, 0.12, 0.4,
      ],
      [
        0.12, 0.04, 0.04, 0.12, 0.04, 0, 0, 0.04, 0.04, 0, 0, 0.04, 0.12, 0.04,
        0.04, 0.12,
      ],
      [0.04, 0, 0, 0.04, 0, 0, 0, 0, 0, 0, 0, 0, 0.04, 0, 0, 0.04],
      Array.from({ length: 16 }, () => 0),
    ];

    const render = () => {
      if (dead) return;

      ctx.fillStyle = "#FA5D19";
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let index = 0; index < 16; index++) {
        ctx.globalAlpha = rects[index].alpha;

        ctx.beginPath();
        ctx.roundRect(
          rects[index].x,
          rects[index].y,
          rects[index].width,
          rects[index].height,
          rects[index].borderRadius,
        );
        ctx.fill();
      }

      requestAnimationFrame(render);
    };

    const cycle = () => {
      if (activeGroup === 2 && dead) return;

      activeGroup = (activeGroup + 1) % 6;

      grid[activeGroup].forEach((alpha, index) => {
        animate(rects[index].alpha, alpha, {
          duration: 0.05,
          onUpdate: (value) => {
            rects[index].alpha = value;
          },
        });
      });

      setTimeout(
        () => {
          if (!dead) {
            cycle();
          }
        },
        activeGroup === 5 ? 200 : 100,
      );
    };

    cycle();
    render();

    canvas.addEventListener("resize", render);

    return () => {
      dead = true;
    };
  }, []);

  return (
    <motion.canvas
      animate={{ opacity: 1, scale: 1 }}
      className="absolute top-0 left-0 size-20"
      exit={{ opacity: 0, scale: 0.9 }}
      ref={canvasRef}
    />
  );
});
