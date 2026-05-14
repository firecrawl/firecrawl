import { Ticker } from "@/components/shared/pixi/Pixi";
import PixiAssetManager from "@/components/shared/pixi/PixiAssetManager";
import { RenderTexture, Sprite, Text } from "pixi.js";

// Add more contrast to the ASCII_CHARS and ensure 'X' is used
// const ASCII_CHARS = [' ', '.', ':', '-', '=', '+', 'X'];
const ASCII_CHARS = ' .":,-_^=+';

function getAsciiChar(luminance: number) {
  if (luminance < 50) return " ";

  const norm = Math.max(0, Math.min(1, (luminance - 16) / (250 - 16)));
  const skewed = Math.pow(norm, 1.5);

  const minIdx = 1;
  const maxIdx = ASCII_CHARS.length - 1;
  const idx = minIdx + Math.floor(skewed * (maxIdx - minIdx + 1));
  const safeIdx = Math.max(minIdx, Math.min(maxIdx, idx));

  return ASCII_CHARS[safeIdx];
}

// Sprinkle logic is now a no-op, as getAsciiChar handles the randomness
function sprinkleAscii(line: string) {
  return line;
}

const tickAscii: Ticker = async ({ app, canvas }) => {
  const textures = await Promise.all(
    Array.from({ length: 150 }, async (_, i) => {
      const texture = await PixiAssetManager.load(
        `/Arşiv/FAQ Demo/FAQ_${i.toString().padStart(5, "0")}.png`,
      );

      return texture!;
    }),
  );

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  const sprites = textures.map((texture) => new Sprite(texture));

  sprites.forEach((sprite) => {
    sprite.width = width;
    sprite.height = height;
    sprite.x = 0;
    sprite.y = 0;

    app.stage.addChild(sprite);
    sprite.alpha = 0;
  });

  // Render the texture to a renderTexture to extract pixels
  const renderTexture = RenderTexture.create({ width, height });

  let ascii = "";

  const asciiText = new Text({
    text: ascii,
    style: {
      fontFamily: "monospace",
      fontSize: 8,
      fill: 0x000,
      align: "left",
      lineHeight: 8,
      whiteSpace: "pre",
    },
  });
  asciiText.alpha = 0.2;
  asciiText.x = 0;
  asciiText.y = 0;

  const variants: string[] = [];

  const render = (index: number) => {
    ascii = "";
    const sprite = sprites[index];

    sprites.forEach((sprite) => {
      sprite.alpha = 0;
    });

    sprite.alpha = 1;
    app.renderer.render({ container: sprite, target: renderTexture });
    sprite.alpha = 0;

    const pixels = app.renderer.extract.pixels(renderTexture).pixels;

    const charWidth = 4.81640625;

    for (let y = 0; y < height; y += 8) {
      let line = "";

      for (let x = 0; x < width; x += charWidth) {
        let totalLum = 0;
        let count = 0;

        for (let dy = 0; dy < 8; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            const px = Math.floor(x + dx);
            const py = Math.floor(y + dy);
            if (px >= width || py >= height) continue;
            const idx = (py * width + px) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            totalLum += lum;
            count++;
          }
        }
        const avgLum = count ? totalLum / count : 0;
        line += getAsciiChar(avgLum);
      }
      ascii += sprinkleAscii(line) + "\n";
    }

    variants[index] = ascii;

    asciiText.text = ascii;
  };

  app.stage.addChild(asciiText);

  for (let i = 0; i < sprites.length; i++) {
    render(i);
  }

  let i = 0;

  //@ts-ignore
  app.ticker.safeAdd(() => {
    i++;
    if (i >= sprites.length) i = 0;

    render(i);
  });
};

export default tickAscii;
