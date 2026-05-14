"use client";

import { useEffect, useRef } from "react";

import dynamic from "next/dynamic";

export default dynamic(() => Promise.resolve(Scrollbar), { ssr: false });

const padding = 8;

function Scrollbar() {
  const ref = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startScrollY = useRef(0);

  useEffect(() => {
    const thumbElement = ref.current!.children[0] as HTMLDivElement;

    let thumbHeight = 0;

    const updateBounds = () => {
      const maxScrollY = document.body.scrollHeight - window.innerHeight;

      thumbHeight = window.innerHeight / document.body.scrollHeight;

      const scrollPosition =
        padding +
        (window.scrollY / maxScrollY) *
          (window.innerHeight - thumbHeight * window.innerHeight - padding * 2);

      Object.assign(thumbElement.style, {
        height: `${thumbHeight * 100}%`,
        transform: `translateY(${scrollPosition}px)`,
      });
    };

    updateBounds();

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const deltaY = e.clientY - startY.current;
      const maxScrollY = document.body.scrollHeight - window.innerHeight;
      const scrollRatio =
        deltaY / (window.innerHeight - thumbHeight * window.innerHeight);

      window.scrollTo({
        top: startScrollY.current + scrollRatio * maxScrollY,
        behavior: "instant",
      });

      showScrollbar();
    };

    let scrollbarHideTimeout: number = 0;

    const showScrollbar = () => {
      if (thumbHeight === 1 || window.innerWidth < 996) return;

      clearTimeout(scrollbarHideTimeout);

      thumbElement.classList.remove("opacity-0");

      scrollbarHideTimeout = window.setTimeout(() => {
        thumbElement.classList.add("opacity-0");
      }, 1000);
    };

    const onMouseUp = () => {
      isDragging.current = false;

      document.body.style.userSelect = "";

      thumbElement.classList.remove("!bg-black/40", "!w-8", "!right-6");

      showScrollbar();
    };

    const onMouseDown = (e: MouseEvent) => {
      isDragging.current = true;
      startY.current = e.clientY;
      startScrollY.current = window.scrollY;

      document.body.style.userSelect = "none";

      thumbElement.classList.add("!bg-black/40", "!w-8", "!right-6");

      showScrollbar();
    };

    const onScroll = () => {
      updateBounds();
      showScrollbar();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    window.addEventListener("scroll", onScroll, { passive: true });

    thumbElement.addEventListener("mousedown", onMouseDown);

    const container = ref.current!;

    container.addEventListener("mouseenter", showScrollbar);

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mouseenter", showScrollbar);
    };
  }, []);

  return (
    <div className="fixed right-0 w-16 z-[1000] h-screen top-0" ref={ref}>
      <div className="bg-black/10 opacity-0 backdrop-blur-4 hover:w-6 w-4 right-8 hover:right-7 transition-[width,right,opacity] duration-[200ms] hover:bg-black/20 absolute top-0 rounded-full" />
    </div>
  );
}
