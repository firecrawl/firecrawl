import { Ticker } from "@/components/shared/pixi/Pixi";
import AnimatedRect from "./components/AnimatedRect";

type Props = Parameters<Ticker>[0] & {
  x: number;
  y: number;
};

export default function cellReveal(props: Props) {
  const graphic = AnimatedRect({
    app: props.app,
    x: props.x + 0.5,
    y: props.y + 0.5,
    width: 101,
    height: 101,
    radius: 0,
    alpha: 0,
    color: 0x000,
    centering: false,
  });

  props.app.stage.addChild(graphic.graphic);

  return {
    trigger: async () => {
      let cycleCount = 0;

      const cycle = async () => {
        await graphic.animate(
          {
            alpha: Math.random() * 0.04,
          },
          {
            ease: "linear",
            duration: 0.03,
          },
        );

        if (cycleCount < 5) {
          cycleCount += 1;
          cycle();
        } else {
          await graphic.animate({ alpha: 0 });
          graphic.graphic.destroy();
        }
      };

      cycle();
    },
  };
}
