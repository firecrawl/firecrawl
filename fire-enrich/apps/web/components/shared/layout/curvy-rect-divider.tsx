import React from "react";

import CurvyRect from "./curvy-rect";

export function CurvyRectDivider() {
  return (
    <div className="relative mx-1 my-1">
      <div className="relative h-px bg-zinc-200 border-x border-zinc-200">
        <CurvyRect
          className="absolute -top-[0.5px] -left-[1px] w-[calc(100%+2px)]"
          top
        />
        <CurvyRect
          className="absolute -bottom-[0.5px] -left-[1px] w-[calc(100%+2px)]"
          bottom
        />
        <CurvyRect
          className="absolute -left-[0.5px] -top-[1px] h-[calc(100%+2px)]"
          left
        />
        <CurvyRect
          className="absolute -right-[0.5px] -top-[1px] h-[calc(100%+2px)]"
          right
        />
      </div>
    </div>
  );
}
