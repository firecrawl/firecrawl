import { debounce } from "lodash-es";

export default (canvas: HTMLCanvasElement) => {
  const { width, height } = canvas.getBoundingClientRect();
  const ctx = canvas.getContext("2d")!;

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const upscaleCanvas = () => {
    const scale = window.visualViewport?.scale || 1;
    const dpr = (window.devicePixelRatio || 1) * scale;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    ctx.scale(dpr, dpr);

    canvas.dispatchEvent(new Event("resize"));
  };

  upscaleCanvas();

  const handleResize = debounce(upscaleCanvas, 500);

  window.addEventListener("resize", handleResize);
  window.visualViewport?.addEventListener("resize", handleResize);

  return ctx;
};
