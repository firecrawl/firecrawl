import { Ticker } from "@/components/shared/pixi/Pixi";
import { sleep } from "@/utils/sleep";

import { CELL_SIZE, MAIN_COLOR } from "./cell";
import AnimatedRect, { IAnimatedRect } from "./components/AnimatedRect";
import { IBlinkingContainer } from "./components/BlinkingContainer";
import Dot from "./components/Dot";

type Props = Parameters<Ticker>[0] & {
  x: number;
  y: number;
  blinkingContainer: IBlinkingContainer;
  anchorGraphic: IAnimatedRect;
};

export default async function search(props: Props) {
  const rects = Array.from({ length: 8 }, () => {
    return AnimatedRect({
      app: props.app,
      x: CELL_SIZE / 2,
      y: CELL_SIZE / 2,
      width: 10,
      height: 10,
      radius: 0,
      color: MAIN_COLOR,
    });
  });

  const dots = Array.from({ length: 16 }, () => {
    return Dot({
      x: CELL_SIZE / 2,
      y: CELL_SIZE / 2,
      app: props.app,
    });
  });

  dots.forEach((dot) =>
    props.blinkingContainer.container.addChild(dot.graphic),
  );

  await sleep(500);

  await props.anchorGraphic.animate({
    radius: 0,
    width: 12,
    height: 12,
  });

  rects.forEach((rect) =>
    props.blinkingContainer.container.addChild(rect.graphic),
  );

  rects.unshift(props.anchorGraphic);

  await sleep(500);

  props.blinkingContainer.blink({ delay: 0.1 });
  await props.blinkingContainer.shrink();

  await Promise.all(
    [
      dots.map((dot, index) => {
        const x = 13 + (index % 4) * 18;
        const y = 13 + Math.floor(index / 4) * 18;

        return dot.animate({ x, y });
      }),

      rects[0].animate({ width: 10, height: 10 }),

      rects.map((rect, index) => {
        const x = 22 + (index % 3) * 18;
        const y = 22 + Math.floor(index / 3) * 18;

        return rect.animate({ x, y });
      }),
    ].flat(),
  );

  await sleep(300);

  Promise.all(
    [
      rects.map((rect) => rect.animate({ alpha: 0.68 })),
      dots.map((dot) => dot.animate({ alpha: 0.68 })),
    ].flat(),
  );

  props.blinkingContainer.blink();
  await sleep(400);

  for await (const rect of rects) {
    // Get the surrounding dots of this rect
    const rectX = rect.currentProps.x;
    const rectY = rect.currentProps.y;
    const surroundingDots = dots.filter((dot) => {
      const dx = Math.abs(dot.currentProps.x - rectX);
      const dy = Math.abs(dot.currentProps.y - rectY);

      // Consider "surrounding" as adjacent horizontally, vertically, or diagonally (distance 18)
      return (
        (dx === 0 && dy === 9) ||
        (dx === 9 && dy === 0) ||
        (dx === 9 && dy === 9)
      );
    });

    await Promise.all(
      [
        surroundingDots.map((dot) =>
          dot.animate({ alpha: 1 }, { duration: 0.75 }),
        ),
        rect.animate({ alpha: 1, width: 14, height: 14 }, { duration: 0.75 }),
      ].flat(),
    );

    rect.animate({ alpha: 0.68, width: 10, height: 10 }, { duration: 0.75 });
    Promise.all(
      surroundingDots.map((dot) =>
        dot.animate({ alpha: 0.68 }, { duration: 0.75 }),
      ),
    );
  }

  await Promise.all(
    [
      rects.map((rect) =>
        rect.animate(props.anchorGraphic.defaultProps, {
          delay: Math.random() * 0.3,
          duration: 0.3,
        }),
      ),

      dots.map((dot) =>
        dot.animate(dot.defaultProps, { delay: Math.random() * 0.3 }),
      ),
    ].flat(),
  );

  rects.shift();

  rects.forEach((rect) => rect.graphic.destroy());
  dots.forEach((dot) => dot.graphic.destroy());
}
