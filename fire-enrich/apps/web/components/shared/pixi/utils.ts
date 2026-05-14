// @ts-nocheck

import { Application, Assets, Sprite, Texture } from "pixi.js";

export const isDestroyed = (app: Application) => {
  if (!app.ticker || !app.renderer || !app.stage || !app.renderer.gl)
    return true;

  return app.renderer.gl.isContextLost();
};

export const generateTexture = (app: Application, graphic: any) => {
  const renderer = app.renderer;

  if (!isDestroyed(app)) {
    return renderer.generateTexture(graphic);
  }

  return Texture.WHITE;
};

export const degreesToRadians = (degrees: number) => {
  return degrees * (Math.PI / 180);
};

export const imageToSprite = async (app: Application, path: string) => {
  let texture;

  if (Assets.cache.has(path)) {
    texture = Assets.cache.get(path);
  } else {
    texture = await Assets.load(path);
  }

  const sprite = Sprite.from(texture);

  return sprite;
};

export const createRenderWithFPS = (app: Application, fps: number) => {
  let lastUpdateTime = 0;

  return () => {
    const currentTime = performance.now();
    const timeSinceLastUpdate = currentTime - lastUpdateTime;

    if (timeSinceLastUpdate >= 1000 / fps) {
      app.ticker.update();
      app.render();
      lastUpdateTime = currentTime;
    }
  };
};

export const waitUntilPixiIsReady = (app: Application) => {
  return new Promise((resolve) => {
    app.canvas.addEventListener("pixi-initialized", resolve);
  });
};
