import type { APIRoute } from "astro";
import { readFile } from "fs/promises";

export const GET: APIRoute = async () => {
  const fileUrl = new URL("../../public/example.pdf", import.meta.url);
  const body = await readFile(fileUrl);

  return new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
    },
  });
};
