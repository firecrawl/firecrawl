import type { Format } from "./types.js";

export const screenshotFormat: Format = {
  name: "screenshot",
  ext: ".png",
  apiFormats: ["screenshot"],
  fromResponse(data) {
    const shot = data.screenshot;
    if (typeof shot !== "string" || !shot) return Buffer.alloc(0);
    const base64 = shot.startsWith("data:") ? shot.slice(shot.indexOf(",") + 1) : shot;
    return Buffer.from(base64, "base64");
  },
};
