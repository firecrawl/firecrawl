"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/utils/cn";

export default function HeaderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const [shouldShrink, setShouldShrink] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const heroContentHeight =
      document.getElementById("hero-content")?.clientHeight;
    const triggerTop = heroContentHeight ? heroContentHeight : 100;

    const onScroll = () => {
      setShouldShrink(window.scrollY > triggerTop);
    };

    onScroll();

    window.addEventListener("scroll", onScroll);
  }, [pathname]);

  return (
    <div
      className={cn(
        "container lg:px-56 px-16 flex justify-between transition-[padding] duration-[200ms] items-center",
        shouldShrink ? "py-20" : "py-20 lg:py-34",
      )}
    >
      {children}
    </div>
  );
}
