import { animate } from "motion";

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

export default async function crawl(props: Props) {
  const rects = Array.from({ length: 6 }, () => {
    return AnimatedRect({
      app: props.app,
      x: CELL_SIZE / 2,
      y: CELL_SIZE / 2,
      width: 8,
      height: 8,
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

  /* Step 1: Reveal the main square, reveal the corner dots */
  await Promise.all(
    [
      dots[0].animate({ x: 30, y: 30 }, { delay: 0.2 }),
      dots[1].animate({ x: CELL_SIZE - 30, y: 30 }, { delay: 0.2 }),
      dots[2].animate({ x: 30, y: CELL_SIZE - 30 }, { delay: 0.2 }),
      dots[3].animate({ x: CELL_SIZE - 30, y: CELL_SIZE - 30 }, { delay: 0.2 }),

      props.anchorGraphic.animate({
        radius: 0,
        width: 12,
        height: 12,
      }),
    ].flat(),
  );

  rects.forEach((rect) =>
    props.blinkingContainer.container.addChild(rect.graphic),
  );

  rects.unshift(props.anchorGraphic);

  await sleep(500);
  props.blinkingContainer.blink({ delay: 0.3 });
  await props.blinkingContainer.shrink();

  let spriteOverlay: IAnimatedRect | null = null;

  // Use fallback rectangle instead of trying to load missing image
  spriteOverlay = AnimatedRect({
    x: 13,
    y: 39,
    color: MAIN_COLOR,
    width: 54,
    height: 34,
    app: props.app,
    radius: 4,
    centering: false,
  });

  spriteOverlay.graphic.zIndex = -1;
  props.blinkingContainer.container.addChild(spriteOverlay.graphic);

  await Promise.all(
    [
      spriteOverlay?.animate({ height: 23, y: 50 }),

      rects[0].animate({ width: 16, height: 16, y: 34 }),
      rects.slice(1, 4).map((rect) => rect.animate({ x: 24, y: 50 })),
      rects.slice(4, 8).map((rect) => rect.animate({ x: 56, y: 50 })),

      dots[0].animate({ x: 28, y: 22 }),
      dots[1].animate({ x: 52, y: 22 }),
      dots[2].animate({ x: 16, y: 58 }),
      dots[3].animate({ x: 64, y: 58 }),

      dots[4].animate({ x: 16, y: 42 }),
      dots[5].animate({ x: 64, y: 42 }),
      dots[6].animate({ x: 32, y: 58 }),
      dots[7].animate({ x: 48, y: 58 }),

      dots.slice(8, 12).map((dot) => dot.animate({ x: 24, y: 50 })),
      dots.slice(12, 16).map((dot) => dot.animate({ x: 56, y: 50 })),
    ].flat().filter(Boolean),
  );

  await sleep(500);
  props.blinkingContainer.blink({ delay: 0.3 });
  await props.blinkingContainer.shrink();
  try {
    await Promise.all(
      [
        spriteOverlay?.animate({ height: 8, y: 58 }),

        rects[0].animate({ y: 28 }),
        [1, 4].map((i) => rects[i].animate({ y: 44 })),
        [2, 3].map((i) => rects[i].animate({ x: 12, y: 56 })),
        [5, 6].map((i) => rects[i].animate({ x: 68, y: 56 })),

        dots[0].animate({ y: 16 }),
        dots[1].animate({ y: 16 }),

        dots[2].animate({ x: 4, y: 64 }),
        dots[3].animate({ x: 76, y: 64 }),

        dots[4].animate({ x: 4, y: 48 }),
        dots[5].animate({ x: 76, y: 48 }),
        dots[6].animate({ x: 20, y: 64 }),
        dots[7].animate({ x: 60, y: 64 }),

        dots[8].animate({ x: 16, y: 36 }),
        dots[12].animate({ x: 64, y: 36 }),

        dots[9].animate({ x: 32, y: 52 }),
        dots[13].animate({ x: 48, y: 52 }),

        [10, 11].map((i) => dots[i].animate({ x: 12, y: 56 })),
        [14, 15].map((i) => dots[i].animate({ x: 68, y: 56 })),
      ].flat().filter(Boolean),
    );
  } catch (e) {
    console.error(e);
  }

  await sleep(500);
  props.blinkingContainer.blink({ delay: 0.3 });
  await props.blinkingContainer.shrink();

  await Promise.all(
    [
      spriteOverlay.animate({ height: 0, y: 66 }),

      rects[0].animate({ y: 20 }),
      [1, 4].map((i) => rects[i].animate({ y: 36 })),
      [2, 5].map((i) => rects[i].animate({ y: 48 })),
      [3, 6].map((i) => rects[i].animate({ y: 60, x: i === 3 ? 24 : 56 })),

      [0, 1, 4, 5, 8, 9, 12, 13].map((i) =>
        dots[i].animate({ y: dots[i].currentProps.y - 8 }),
      ),

      dots[2].animate({ x: 4, y: 56 }),
      dots[3].animate({ x: 76, y: 56 }),

      dots[6].animate({ x: 32, y: 68 }),
      dots[7].animate({ x: 48, y: 68 }),

      dots[10].animate({ x: 32, y: 52 }),
      dots[11].animate({ x: 16, y: 68 }),
      dots[14].animate({ x: 48, y: 52 }),
      dots[15].animate({ x: 64, y: 68 }),
    ].flat(),
  );

  await sleep(2000);

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
  spriteOverlay.graphic.destroy();
}
