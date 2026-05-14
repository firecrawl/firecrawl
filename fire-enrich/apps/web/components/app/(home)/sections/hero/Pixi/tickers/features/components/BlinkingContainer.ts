//@ts-nocheck

import { Application, Graphics } from "pixi.js";

import { CELL_SIZE } from "@/components/app/(home)/sections/hero/Pixi/tickers/features/cell";

import AnimatedRect from "./AnimatedRect";

export type IBlinkingContainer = ReturnType<typeof BlinkingContainer>;

export default function BlinkingContainer({
  x,
  y,
  app,
}: {
  x: number;
  y: number;
  app: Application;
}) {
  const animatedRect = AnimatedRect({
    app,
    x: 0,
    y: 0,
    width: CELL_SIZE,
    height: CELL_SIZE,
    radius: 0,
    color: 0xededed,
    type: "container",
  });

  animatedRect.graphic.pivot.set(CELL_SIZE / 2, CELL_SIZE / 2);

  animatedRect.graphic.x = x + CELL_SIZE / 2;
  animatedRect.graphic.y = y + CELL_SIZE / 2;

  animatedRect.graphic.addChild(
    new Graphics()
      .rect(0, 0, CELL_SIZE, CELL_SIZE)
      .fill({ color: "#EDEDED", alpha: 0 }),
  );

  const blinkLayer = new Graphics()
    .rect(0, 0, CELL_SIZE, CELL_SIZE)
    .fill({ color: "#F9F9F9" });

  blinkLayer.zIndex = 1;
  blinkLayer.alpha = 0;

  animatedRect.graphic.addChild(blinkLayer);

  return {
    container: animatedRect.graphic,
    animate: animatedRect.animate,
    reset: animatedRect.reset,
    shrink: async () => {
      await animatedRect.animate({ scale: 0.92 });

      animatedRect.animate({ scale: 1 });
    },
    blink: ({ delay = 0 }: { delay?: number } = {}) => {
      app
        .animate(0, 0.32, {
          repeatType: "reverse",
          repeat: 2,
          delay,
          duration: 0.065,
          ease: "linear",
          onUpdate: (value) => {
            blinkLayer.alpha = value as number;
          },
        })
        .then(() => {
          app.animate(0.32, 0, {
            duration: 0.065,
            ease: "linear",
            onUpdate: (value) => {
              blinkLayer.alpha = value as number;
            },
          });
        });
    },
  };
}
