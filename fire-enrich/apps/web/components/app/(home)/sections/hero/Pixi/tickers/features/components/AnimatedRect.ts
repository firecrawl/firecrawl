//@ts-nocheck

import { AnimationOptions, cubicBezier } from "motion";
import { Application, Container, Graphics, Sprite } from "pixi.js";

import { isDestroyed } from "@/components/shared/pixi/utils";

type Props = {
  app: Application;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  color: number;
  scale?: number;
  rotation?: number;
  type?: "rect" | "arc" | "container" | Sprite;
  animationConfig?: AnimationOptions;
  alpha?: number;

  centering?: boolean;
};

export type IAnimatedRect = ReturnType<typeof AnimatedRect>;

export default function AnimatedRect(props: Props) {
  const graphic = (() => {
    if (props.type === "container") return new Container();
    if (props.type instanceof Sprite) return props.type;

    return new Graphics();
  })();

  props.alpha ??= 1;
  props.scale ??= 1;
  props.centering ??= true;
  props.rotation ??= 0;

  const p = {
    ...props,
  };

  const render = () => {
    if (isDestroyed(props.app) || graphic.destroyed) return;

    graphic.scale.set(p.scale!);
    graphic.alpha = p.alpha!;
    graphic.rotation = p.rotation!;

    if (!(graphic instanceof Graphics)) {
      if (graphic instanceof Sprite) {
        graphic.x = p.x;
        graphic.y = p.y;
      }

      return;
    }

    const g = graphic as Graphics;

    g.clear();

    if (p.type !== "arc") {
      g.roundRect(
        p.centering ? p.x - p.width / 2 : p.x,
        p.centering ? p.y - p.height / 2 : p.y,
        p.width,
        p.height,
        p.radius,
      );
    } else {
      g.arc(p.x, p.y, p.width / 2, 0, Math.PI * 2);
    }

    g.fill({ color: p.color });
  };

  render();

  p.animationConfig ??= {
    duration: 0.4,
    ease: cubicBezier(0.83, 0, 0.17, 1),
  };

  return {
    defaultProps: props,
    currentProps: p,
    graphic,
    setStyle: (style: Partial<Props>) => {
      Object.assign(p, style);

      render();
    },
    render,
    animate: (renderProps: Partial<Props>, settings?: AnimationOptions) =>
      props.app.animate(p, renderProps, {
        ...p.animationConfig,
        ...settings,
        onUpdate: render,
      }),
    reset: () => props.app.animate(p, props, { onUpdate: render }),
  };
}
