/* eslint-disable @next/next/no-img-element */
import { ComponentProps } from "react";

import compressorConfig from "@/public/compressor.json";

interface Props extends ComponentProps<"img"> {
  src: string;
  alt: string;
  raw?: boolean;
}

const BASE_SRC = "/assets/";
const RAW_SRC = "/assets-original/";

export default function Image({ src, raw, ...attrs }: Props) {
  if (raw) {
    return (
      <img
        {...attrs}
        alt={attrs.alt}
        decoding="async"
        loading="lazy"
        src={RAW_SRC + src + ".png"}
      />
    );
  }

  return (
    <picture>
      {compressorConfig.configs
        .sort((a, b) => {
          if (a.extension === "avif" && b.extension !== "avif") return -1;
          if (b.extension === "avif" && a.extension !== "avif") return 1;

          return a.scale - b.scale;
        })
        .map((c) => {
          return (
            <source
              key={`${c.extension}_q${c.quality}@${c.scale}x`}
              srcSet={`${BASE_SRC}${src}_q${c.quality}@${c.scale}x.${c.extension}`}
              type={`image/${c.extension}`}
            />
          );
        })}

      <img
        {...attrs}
        alt={attrs.alt}
        decoding="async"
        loading="lazy"
        src={`${BASE_SRC}${src}.png`}
      />
    </picture>
  );
}
