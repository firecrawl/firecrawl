import compressorConfig from "@/public/compressor.json";

const avifConfig = compressorConfig.configs.find(
  (c) => c.extension === "avif",
)!;
const webpConfig = compressorConfig.configs.find(
  (c) => c.extension === "webp",
)!;

export async function getImageSrc(src: string) {
  const BASE_SRC = "/assets/";

  if (await supportsEncode()) {
    return `${BASE_SRC}${src}_q${avifConfig.quality}@${avifConfig.scale}x.avif`;
  }

  return `${BASE_SRC}${src}_q${webpConfig.quality}@${webpConfig.scale}x.webp`;
}

let promise: Promise<boolean> | null = null;

async function supportsEncode() {
  if (promise) return promise;

  const avifData =
    "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABYAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgSAAAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB5tZGF0EgAKBzgADlAgIGkyCR/wAABAAACvcA==";

  promise = fetch(avifData)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then(() => true)
    .catch(() => false);

  return promise;
}
