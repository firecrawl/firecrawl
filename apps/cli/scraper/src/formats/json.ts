import type { Format } from "./types.js";

export const jsonFormat: Format = {
  name: "json",
  ext: ".json",
  apiFormats: ["markdown", "html", "links"],
  fromResponse(data) {
    return JSON.stringify(data, null, 2);
  },
};
