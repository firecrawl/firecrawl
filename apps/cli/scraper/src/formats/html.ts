import type { Format } from "./types.js";

export const htmlFormat: Format = {
  name: "html",
  ext: ".html",
  apiFormats: ["html"],
  fromResponse(data) {
    return (data.html as string | undefined) ?? (data.rawHtml as string | undefined) ?? "";
  },
};
