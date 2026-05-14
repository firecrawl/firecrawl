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

export default async function mapping(props: Props) {
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

  const dots = Array.from({ length: 20 }, () => {
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
      dots.slice(0, 16).map((dot, index) => {
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

  props.blinkingContainer.blink({ delay: 0.1 });
  await props.blinkingContainer.shrink();

  const baseDotPositions = [
    [13, 13],
    [31, 31],
    [49, 31],
    [13, 31],
    [49, 49],
    [67, 49],
    [13, 49],
    [31, 67],
    [67, 67],
  ];

  const dotPositions: string[] = [];

  for (const [x, y] of baseDotPositions) {
    const positions = [
      { x: x - 9, y: y - 9 },
      { x: x + 9, y: y - 9 },
      { x: x - 9, y: y + 9 },
      { x: x + 9, y: y + 9 },
    ];

    for (const position of positions) {
      if (!dotPositions.includes(`${position.x},${position.y}`)) {
        dotPositions.push(`${position.x},${position.y}`);
      }
    }
  }

  await Promise.all(
    [
      rects[0].animate({ x: 13, y: 13 }),
      rects[1].animate({ x: 31, y: 31 }),
      rects[2].animate({ x: 49, y: 31 }),
      rects[3].animate({ x: 13, y: 31 }),

      rects[4].animate({ x: 49, y: 49 }),
      rects[5].animate({ x: 67, y: 49 }),

      rects[6].animate({ x: 13, y: 49 }),
      rects[7].animate({ x: 31, y: 67 }),
      rects[8].animate({ x: 67, y: 67 }),

      dots.map((dot, index) => {
        const position = dotPositions[index].split(",").map(Number);

        return dot.animate({ x: position[0], y: position[1] });
      }),
    ].flat(),
  );

  await sleep(500);

  const lines = Array.from({ length: 8 }, () => {
    return AnimatedRect({
      app: props.app,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      radius: 0,
      color: MAIN_COLOR,
      centering: false,
      animationConfig: {
        duration: 0.25,
        ease: "linear",
      },
    });
  });

  lines.forEach((graphic) =>
    props.blinkingContainer.container.addChild(graphic.graphic),
  );

  (async () => {
    lines[0].setStyle({ width: 1, height: 0, y: 18, x: 12.5 });
    await lines[0].animate({ height: 9 });

    lines[1].setStyle({ width: 0, height: 1, y: 30.5, x: 18 });
    await lines[1].animate({ width: 9 });
    lines[2].setStyle({ width: 0, height: 1, y: 30.5, x: 36 });
    await lines[2].animate({ width: 9 });

    lines[3].setStyle({ width: 1, height: 3, y: 36, x: 48.5 });
    await lines[3].animate({ height: 9 });
    lines[4].setStyle({ width: 0, height: 1, y: 48.5, x: 54 });
    await lines[4].animate({ width: 9 });
  })();

  lines[5].setStyle({ width: 0, height: 1, y: 66.5, x: 62 });
  await lines[5].animate({ width: 28, x: 62 - 28 }, { duration: 0.4 });
  lines[6].setStyle({ width: 0, height: 1, y: 66.5, x: 26 });
  await lines[6].animate({ width: 13.5, x: 26 - 13.5 });
  lines[7].setStyle({ width: 1, height: 0, y: 66.5, x: 12.5 });
  await lines[7].animate({ height: 14.5, y: 66.5 - 13.5 });

  await sleep(2000);

  props.blinkingContainer.blink({ delay: 0.1 });

  await Promise.all(
    [
      lines.map((line) => line.animate({ alpha: 0 })),

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

  lines.forEach((line) => line.graphic.destroy());
  rects.forEach((rect) => rect.graphic.destroy());
  dots.forEach((dot) => dot.graphic.destroy());
}
