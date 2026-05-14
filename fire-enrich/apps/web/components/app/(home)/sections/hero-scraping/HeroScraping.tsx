"use client";

import { animate } from "motion";
import { useEffect, useRef, useState } from "react";

import CurvyRect from "@/components/shared/layout/curvy-rect";
import { sleep } from "@/utils/sleep";

import BrowserMobile from "./_svg/BrowserMobile";
import BrowserTab from "./_svg/BrowserTab";
import HeroScrapingCode from "./Code/Code";
import HeroScrapingTag from "./Tag/Tag";

import "./HeroScraping.css";

export default function HeroScraping() {
  const [step, setStep] = useState(-1);

  const navigationRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const h1Ref = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapElement = async (
      element: HTMLElement,
      { borderRadius }: { borderRadius?: number } = {},
    ) => {
      if (!containerRef.current) return;

      const containerBnds = containerRef.current.getBoundingClientRect();
      const elementBnds = element.getBoundingClientRect();

      if (!highlightRef.current) return;

      try {
        if (highlightRef.current) {
          await animate(
            highlightRef.current,
            { opacity: 0 },
            { duration: 0.3 },
          );
        }
      } catch (error) {
        console.error("Error animating highlight:", error);
      }

      if (!highlightRef.current) return;

      Object.assign(highlightRef.current.style, {
        left: elementBnds.left - containerBnds.left - 4 + "px",
        top: elementBnds.top - containerBnds.top - 4 + "px",
        width: elementBnds.width + 8 + "px",
        height: elementBnds.height + 8 + "px",
        borderRadius: borderRadius ? `${borderRadius}px` : undefined,
      });

      try {
        await animate(
          highlightRef.current,
          { opacity: [1, 0.5, 0.3, 0.8, 0.6, 0.9, 0.7, 1] },
          { duration: 0.4 },
        );
      } catch (error) {
        console.error("Error animating highlight:", error);
      }
    };

    const start = async () => {
      setStep(0);
      if (!highlightRef.current) return;

      await animate(highlightRef.current, {
        scale: 1,
        opacity: 1,
      });

      await sleep(700);

      setTimeout(() => setStep(1), 300);
      if (navigationRef.current) {
        await wrapElement(navigationRef.current);
      }

      await sleep(1200);

      setTimeout(() => setStep(2), 300);
      if (buttonRef.current) {
        await wrapElement(buttonRef.current);
      }

      await sleep(1200);

      setTimeout(() => setStep(3), 300);
      if (h1Ref.current) {
        await wrapElement(h1Ref.current, { borderRadius: 12 });
      }

      await sleep(1200);

      setTimeout(() => setStep(4), 300);
      if (descriptionRef.current) {
        await wrapElement(descriptionRef.current, { borderRadius: 8 });
      }

      await sleep(1200);

      setTimeout(() => setStep(5), 300);
      if (ctaRef.current) {
        await wrapElement(ctaRef.current, { borderRadius: 24 });
      }

      await sleep(1500);
      setTimeout(() => setStep(6), 300);

      if (highlightRef.current) {
        await animate(highlightRef.current, { opacity: 0 }, { duration: 0.3 });
      }
    };

    let started = false;

    const onScroll = () => {
      if (started) return;

      if (window.scrollY > 100) {
        started = true;
        start();
        window.removeEventListener("scroll", onScroll);
      }
    };

    setTimeout(() => {
      if (started) return;

      started = true;
      start();
      window.removeEventListener("scroll", onScroll);
    }, 2000);

    window.addEventListener("scroll", onScroll);

    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className="pt-56 lg:pt-25 lg:px-25 container -mt-36 relative"
      ref={containerRef}
    >
      <div className="h-53 absolute top-[calc(100%-1px)] w-full left-0">
        <div className="h-1 bg-border-faint bottom-0 left-0 w-full absolute" />
      </div>

      <div
        className="left-61 top-89 rounded-[16px] size-32 absolute hero-scraping-highlight before:inside-border before:border-border-loud opacity-0 scale-[0.9]"
        ref={highlightRef}
      />

      <div className="lg:h-370 rounded-t-16 lg-max:pt-70 relative">
        <div className="overlay mask-border lg-max:hidden p-1 bg-gradient-to-b from-black/7 to-transparent" />

        <div className="top-17 left-17 flex gap-8 items-center absolute lg-max:hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              className="w-10 h-10 rounded-full relative before:inside-border before:border-border-muted"
              key={index}
            />
          ))}
        </div>

        <div className="pt-42 lg:px-6">
          <BrowserMobile className="absolute top-0 cw-316 lg:hidden" />

          <BrowserTab className="absolute top-[7.5px] left-70 lg-max:hidden bg-background-base z-[1]" />
          <div className="absolute size-18 top-17 left-89 lg-max:hidden before:inside-border before:border-border-muted z-[2] rounded-full" />

          <div className="rounded-t-16 relative lg:h-330 lg:p-6">
            <div className="overlay mask-border lg-max:hidden p-1 bg-gradient-to-b from-black/7 to-transparent" />

            <div className="lg:h-322 rounded-t-10 relative">
              <div className="overlay mask-border lg-max:hidden p-1 bg-gradient-to-b z-[2] from-black/7 to-transparent" />

              <div className="px-28 lg-max:hidden py-20 flex justify-between items-center relative border-b border-border-faint">
                <div className="flex gap-8 items-center relative">
                  <div className="size-24 rounded-full relative before:inside-border before:border-border-muted" />
                  <div className="w-64 h-12 rounded-full relative before:inside-border before:border-border-muted" />

                  {step >= 0 && (
                    <HeroScrapingTag
                      active={step === 0}
                      className="absolute left-[calc(100%+24px)] top-0"
                      initial={{ x: -12, opacity: 0 }}
                      label="Logo"
                    />
                  )}
                </div>

                <div
                  className="absolute top-24 center-x flex gap-8"
                  ref={navigationRef}
                >
                  {step >= 1 && (
                    <HeroScrapingTag
                      active={step === 1}
                      className="absolute right-[calc(100%+20px)] -top-4"
                      initial={{ x: 12, opacity: 0 }}
                      label="Navigation"
                    />
                  )}

                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      className="w-64 h-16 rounded-full relative before:inside-border before:border-border-muted"
                      key={index}
                    />
                  ))}
                </div>

                <div
                  className="w-72 h-24 rounded-full relative before:inside-border before:border-border-muted"
                  ref={buttonRef}
                >
                  {step >= 2 && (
                    <HeroScrapingTag
                      active={step === 2}
                      className="absolute right-[calc(100%+20px)] top-0"
                      initial={{ x: 12, opacity: 0 }}
                      label="Button"
                    />
                  )}
                </div>
              </div>

              <div className="lg:grid grid-cols-2">
                <div className="pt-40 pl-151 flex gap-16 relative lg-max:hidden">
                  <CurvyRect
                    className="size-32 -top-1 -right-1 absolute"
                    topRight
                  />
                  <div>
                    <div
                      className="flex gap-16 mb-16 flex-wrap w-300 relative"
                      ref={h1Ref}
                    >
                      {step >= 3 && (
                        <HeroScrapingTag
                          active={step === 3}
                          className="absolute right-[calc(100%+16px)] top-0"
                          initial={{ x: 12, opacity: 0 }}
                          label="H1 Title"
                        />
                      )}
                      <div className="w-144 h-32 rounded-8 relative before:inside-border before:border-border-muted" />
                      <div className="w-82 h-32 rounded-8 relative before:inside-border before:border-border-muted" />
                      <div className="w-100 h-32 rounded-8 relative before:inside-border before:border-border-muted" />
                      <div className="w-180 h-32 rounded-8 relative before:inside-border before:border-border-muted" />
                    </div>

                    <div
                      className="flex gap-6 mb-32 flex-wrap w-300 relative"
                      ref={descriptionRef}
                    >
                      {step >= 4 && (
                        <HeroScrapingTag
                          active={step === 4}
                          className="absolute top-0 right-[calc(100%+16px)]"
                          initial={{ x: 12, opacity: 0 }}
                          label="Description"
                        />
                      )}

                      <div className="w-131 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                      <div className="w-72 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                      <div className="w-34 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                      <div className="w-56 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                      <div className="w-116 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                      <div className="w-116 h-10 rounded-full relative before:inside-border before:border-border-muted" />
                    </div>

                    <div
                      className="w-64 h-24 rounded-full relative before:inside-border before:border-border-muted"
                      ref={ctaRef}
                    >
                      {step >= 5 && (
                        <HeroScrapingTag
                          active={step === 5}
                          className="absolute top-0 right-[calc(100%+16px)]"
                          initial={{ x: 12, opacity: 0 }}
                          label="CTA Button"
                        />
                      )}
                    </div>
                  </div>
                </div>

                <HeroScrapingCode step={step} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
