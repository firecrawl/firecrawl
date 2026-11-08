import type { Format } from "./types.js";

export const markdownFormat: Format = {
  name: "markdown",
  ext: ".md",
  apiFormats: ["markdown"],
  fromResponse(data) {
    return data.markdown ?? "";
  },
};
