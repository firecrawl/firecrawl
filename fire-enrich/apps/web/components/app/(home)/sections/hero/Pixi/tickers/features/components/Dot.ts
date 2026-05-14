import { MAIN_COLOR } from "@/components/app/(home)/sections/hero/Pixi/tickers/features/cell";

import AnimatedRect from "./AnimatedRect";

export default function Dot(
  props: Pick<
    Parameters<typeof AnimatedRect>[0],
    "x" | "y" | "app" | "animationConfig"
  >,
) {
  return AnimatedRect({
    ...props,
    width: 2,
    height: 2,
    radius: 10,
    color: MAIN_COLOR,
    type: "arc",
  });
}
