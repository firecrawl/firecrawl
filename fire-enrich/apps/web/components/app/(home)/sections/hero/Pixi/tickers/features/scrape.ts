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

export default async function scrape(props: Props) {
  const rects = Array.from({ length: 15 }, () => {
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

  const dots = Array.from({ length: 25 }, () => {
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

  await Promise.all(
    [
      [0, 12, 13, 14].map((index) =>
        dots[index].animate({ x: 30, y: 30 }, { delay: 0.2 }),
      ),
      [1, 15, 16, 17].map((index) =>
        dots[index].animate({ x: CELL_SIZE - 30, y: 30 }, { delay: 0.2 }),
      ),
      [2, 18, 19, 20].map((index) =>
        dots[index].animate({ x: 30, y: CELL_SIZE - 30 }, { delay: 0.2 }),
      ),
      [3, 21, 22, 23].map((index) =>
        dots[index].animate(
          { x: CELL_SIZE - 30, y: CELL_SIZE - 30 },
          { delay: 0.2 },
        ),
      ),

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

  props.blinkingContainer.blink({ delay: 0.1 });
  await props.blinkingContainer.shrink();

  await Promise.all(
    [
      [0, 12, 13, 14].map((index) => dots[index].animate({ x: 22, y: 22 })),
      [1, 15, 16, 17].map((index) =>
        dots[index].animate({ x: CELL_SIZE - 22, y: 22 }),
      ),
      [2, 18, 19, 20].map((index) =>
        dots[index].animate({ x: 22, y: CELL_SIZE - 22 }),
      ),
      [3, 21, 22, 23].map((index) =>
        dots[index].animate({ x: CELL_SIZE - 22, y: CELL_SIZE - 22 }),
      ),

      dots[4].animate({ x: 40, y: 22 }),
      dots[5].animate({ x: 22, y: 40 }),
      dots[6].animate({ x: CELL_SIZE - 22, y: 40 }),
      dots[7].animate({ x: 40, y: 58 }),

      dots[8].animate({ x: 40, y: 22 }),
      dots[9].animate({ x: 22, y: 40 }),
      dots[10].animate({ x: CELL_SIZE - 22, y: 40 }),
      dots[11].animate({ x: 40, y: 58 }),

      rects[0].animate({ width: 10, height: 10 }),
      rects.slice(0, 4).map((rect) => rect.animate({ x: 31, y: 31 })),
      rects
        .slice(4, 8)
        .map((rect) => rect.animate({ x: CELL_SIZE - 31, y: 31 })),
      rects
        .slice(8, 12)
        .map((rect) => rect.animate({ x: 31, y: CELL_SIZE - 31 })),
      rects
        .slice(12, 16)
        .map((rect) => rect.animate({ x: CELL_SIZE - 31, y: CELL_SIZE - 31 })),
    ].flat(),
  );

  await sleep(1000);

  props.blinkingContainer.blink({ delay: 0.1 });
  await props.blinkingContainer.shrink();

  await Promise.all(
    [
      dots[0].animate({ x: 4, y: 4 }),
      dots[1].animate({ x: CELL_SIZE - 4, y: 4 }),
      dots[2].animate({ x: 4, y: CELL_SIZE - 4 }),
      dots[3].animate({ x: CELL_SIZE - 4, y: CELL_SIZE - 4 }),
      dots[4].animate({ x: 40, y: 4 }),
      dots[5].animate({ x: 4, y: 40 }),
      dots[6].animate({ x: 76, y: 40 }),
      dots[7].animate({ x: 40, y: 76 }),

      dots[13].animate({ x: 22, y: 4 }),
      dots[14].animate({ x: 4, y: 22 }),
      dots[16].animate({ x: 58, y: 4 }),
      dots[17].animate({ x: 76, y: 22 }),
      dots[19].animate({ x: 4, y: 58 }),
      dots[20].animate({ x: 22, y: 76 }),
      dots[22].animate({ x: 58, y: 76 }),
      dots[23].animate({ x: 76, y: 58 }),

      rects.map((rect, index) => {
        const quadrant = Math.floor(index / 4);
        const position = index % 4;

        const col = (position % 2 === 0 ? 1 : 2) + (quadrant % 2 === 0 ? 0 : 2);
        const row = Math.floor(position / 2) + (quadrant < 2 ? 1 : 3);

        return rect.animate({
          x: 13 + (col - 1) * 18,
          y: 13 + (row - 1) * 18,
        });
      }),
    ].flat(),
  );

  await sleep(1200);

  Promise.all(
    dots.map((dot) =>
      dot.animate({ alpha: 0 }, { delay: Math.random() * 0.3 }),
    ),
  );

  await sleep(100);

  props.blinkingContainer.blink({ delay: 0.2 });

  const newWidths: number[] = [];

  for (let i = 0; i < rects.length; i++) {
    if (i % 2 === 0) {
      newWidths.push(20 + Math.random() * 28);
    } else {
      const remainingSpace = 62 - newWidths[i - 1];
      newWidths.push(10 + Math.random() * remainingSpace);
    }
  }

  await Promise.all([
    rects.map((rect, index) => {
      const y = 8 + Math.floor(index / 2) * 6 + Math.floor(index / 4) * 8;

      return rect.animate(
        {
          y,
          x:
            (index % 2 === 0 ? 8 : newWidths[index - 1] + 10) +
            newWidths[index] / 2,
          height: 4,
          width: newWidths[index],
        },
        {
          delay: Math.random() * 0.1,
        },
      );
    }),
  ]);

  props.blinkingContainer.blink({ delay: 0.1 });

  await sleep(2000);

  await Promise.all(
    [
      rects.map((rect) =>
        rect.animate(props.anchorGraphic.defaultProps, {
          delay: Math.random() * 0.3,
          duration: 0.3,
        }),
      ),
    ].flat(),
  );

  rects.shift();

  rects.forEach((rect) => rect.graphic.destroy());
  dots.forEach((dot) => dot.graphic.destroy());
}
