"use client";

import { useEffect, useState } from "react";

import { Connector } from "@/components/shared/layout/curvy-rect";
import {
  useHeaderContext,
  useHeaderHeight,
} from "@/components/shared/header/HeaderContext";
import { cn } from "@/utils/cn";

export const BackgroundOuterPiece = () => {
  const [noRender, setNoRender] = useState(false);
  const { dropdownContent } = useHeaderContext();
  const { headerHeight } = useHeaderHeight();

  useEffect(() => {
    const heroContent = document.getElementById("hero-content");
    if (!heroContent) {
      // If hero-content doesn't exist, don't render the background piece
      setNoRender(true);
      return;
    }

    const heroContentHeight = heroContent.clientHeight;

    const onScroll = () => {
      setNoRender(window.scrollY > heroContentHeight - 120);
    };

    onScroll();

    window.addEventListener("scroll", onScroll);

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div
      className={cn(
        "cw-[1335px] transition-all z-[45] absolute top-0 flex justify-between h-[calc(100%+21px)] duration-[200ms] pointer-events-none",
        { "opacity-0": noRender || dropdownContent || !headerHeight },
      )}
      style={{
        paddingTop: headerHeight - 10,
      }}
    >
      <div className="h-[3000px] w-[calc(100%-21px)] left-[10.5px] absolute bottom-21 border-x border-border-faint" />

      <Connector className="sticky" style={{ top: headerHeight - 10 }} />
      <Connector className="sticky" style={{ top: headerHeight - 10 }} />
    </div>
  );
};
