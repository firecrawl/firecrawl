"use client";
import { animate } from "motion";
import { nanoid } from "nanoid";
import { Application, ApplicationOptions } from "pixi.js";
import { HTMLAttributes, useMemo, useRef } from "react";

import useDebouncedEffect from "@/hooks/useDebouncedEffect";
import { cn } from "@/utils/cn";

import { isDestroyed } from "./utils";

type TickerResult = void;

export type Ticker = ({
  app,
  canvas,
}: {
  app: Application;
  canvas: HTMLCanvasElement;
}) => TickerResult | Promise<TickerResult>;

export interface PixiProps {
  tickers: Ticker[];
  onBeforeInitialized?: (props: { canvas: HTMLCanvasElement }) => void;
  onInitialized?: (props: { canvas: HTMLCanvasElement }) => void;
  canvasAttrs?: HTMLAttributes<HTMLCanvasElement>;
  initOptions?: Partial<ApplicationOptions>;
  fps?: number;
  resolution?: number;
  smartStop?: boolean;
}

export default function Pixi({
  tickers,
  onInitialized,
  onBeforeInitialized,
  canvasAttrs,
  initOptions,
  fps = 60,
  resolution: resolutionFromParams = 1,
  smartStop = true,
}: PixiProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useDebouncedEffect(
    () => {
      const canvas = canvasRef.current!;

      if (!canvas) return;

      const cleanupFunctions: (() => void)[] = [];

      canvas.style.opacity = "0";

      onBeforeInitialized?.({ canvas });

      const resolution = window.devicePixelRatio || 1;

      const app = new Application();

      cleanupFunctions.push(() => {
        if (isDestroyed(app)) return;

        app.destroy(
          {},
          {
            children: true,
            context: true,
            style: true,
          },
        );

        canvas.style.opacity = "0";
      });

      (async () => {
        await app.init({
          canvas: canvas,
          resolution: resolution * resolutionFromParams,
          width: canvas.clientWidth,
          height: canvas.clientHeight,
          antialias: false,
          hello: false,

          autoStart: true,
          sharedTicker: false,
          clearBeforeRender: true,

          eventMode: "passive",

          ...initOptions,
        });

        let tickerCount = 0;
        const originalAdd = app.ticker.add;

        if (fps !== Infinity) {
          app.ticker.maxFPS = fps;
        }

        (app.ticker as any).safeAdd = function (...args: any[]) {
          if (!app.ticker) return undefined as any;

          tickerCount += 1;

          if (tickerCount === 1 && smartStop) startTicker();

          return originalAdd.apply(app.ticker, args as any);
        };

        const originalRemove = app.ticker.remove;

        (app.ticker as any).safeRemove = function (...args: any[]) {
          if (!app.ticker) return undefined as any;

          tickerCount -= 1;

          if (tickerCount === 0 && smartStop) stopTicker();

          return originalRemove.apply(app.ticker, args as any);
        };

        const activeAnimations: ReturnType<typeof animate>[] = [];

        const startTicker = () => {
          app.ticker.start();

          activeAnimations.forEach((animation) => {
            animation.play();
          });
        };

        const stopTicker = () => {
          app.ticker.stop();

          activeAnimations.forEach((animation) => {
            animation.pause();
          });
        };

        (app as any).animate = ((...args: any[]) => {
          const animation = (animate as any)(...args);

          activeAnimations.push(animation);

          animation.finished.then(() => {
            activeAnimations.splice(activeAnimations.indexOf(animation), 1);
          });

          return animation;
        }) as typeof animate;

        for (const ticker of tickers) {
          ticker({
            app,
            canvas,
          });
        }

        app.stage.interactive = false;
        app.stage.cullable = true;
        app.stage.sortableChildren = false;
        app.stage.interactiveChildren = false;

        app.render();

        setTimeout(() => {
          onInitialized?.({ canvas });
          canvas.style.opacity = "1";
        }, 100);

        const observer = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) {
            if (tickerCount !== 0 || !smartStop) startTicker();
          } else {
            stopTicker();
          }
        });

        const resizeObserver = new ResizeObserver(() => {
          app.renderer.resize(canvas.clientWidth, canvas.clientHeight);
          app.renderer.render(app.stage);
        });

        observer.observe(canvas);
        resizeObserver.observe(canvas);

        cleanupFunctions.push(() => {
          resizeObserver.disconnect();
          observer.disconnect();
        });
      })();

      return () => {
        cleanupFunctions.forEach((fn) => fn());
      };
    },
    {
      timeout: 1,
      ignoreInitialCall: false,
    },
    [],
  );

  const key = useMemo(() => {
    return nanoid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers]);

  return (
    <canvas
      {...canvasAttrs}
      className={cn(canvasAttrs?.className)}
      key={key}
      ref={canvasRef}
      style={{
        ...canvasAttrs?.style,
        opacity: 0,
      }}
    />
  );
}
