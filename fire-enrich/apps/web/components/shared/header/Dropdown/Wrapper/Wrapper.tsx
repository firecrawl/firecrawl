// @ts-nocheck
"use client";

import { AnimatePresence, cubicBezier, motion } from "motion/react";
import { useEffect } from "react";

import { Connector } from "@/components/shared/layout/curvy-rect";
import { useHeaderContext } from "@/components/shared/header/HeaderContext";
import { lockBody } from "@/components/shared/lockBody";
import AnimatedHeight from "@/components/shared/layout/animated-height";
export default function HeaderDropdownWrapper() {
  const {
    dropdownContent,
    resetDropdownTimeout,
    clearDropdown,
    dropdownKey,
    headerHeight,
    headerTop,
  } = useHeaderContext();

  useEffect(() => {
    lockBody("header-dropdown", !!dropdownContent);
  }, [dropdownContent]);

  return (
    <AnimatePresence>
      {dropdownContent && (
        <motion.div
          animate={{ opacity: 1 }}
          className="h-screen w-screen fixed left-0 z-[2000] bg-black-alpha-40"
          exit={{
            opacity: 0,
            transition: {
              duration: 0.3,
              delay: 0.1,
              ease: cubicBezier(0.4, 0, 0.2, 1),
            },
          }}
          initial={{ opacity: 0 }}
          style={{
            top: headerTop.current + headerHeight.current + 1,
          }}
          transition={{ duration: 0.3, ease: cubicBezier(0.4, 0, 0.2, 1) }}
        >
          <div
            className="overlay"
            onClick={() => {
              if (window.innerWidth < 996) {
                clearDropdown(true);
              }
            }}
            onMouseEnter={() => {
              if (window.innerWidth > 996) {
                clearDropdown(true);
              }
            }}
          />

          <AnimatedHeight
            animate={{
              transition: { duration: 0.5, ease: cubicBezier(0.4, 0, 0.2, 1) },
            }}
            className="overflow-clip relative"
            exit={{
              height: 0,
              transition: { duration: 0.3, ease: cubicBezier(0.4, 0, 0.2, 1) },
            }}
            initial={{ height: 0 }}
          >
            <AnimatePresence mode="popLayout">
              <motion.div
                className="bg-background-base hide-scrollbar relative overflow-x-clip overflow-y-auto"
                key={dropdownKey}
                style={{
                  maxHeight: `calc(100vh - ${headerTop.current + headerHeight.current + 1}px)`,
                }}
                onMouseEnter={resetDropdownTimeout}
                onMouseLeave={() => {
                  if (window.innerWidth < 996) return;
                  clearDropdown();
                }}
              >
                <div className="cmw-[1112px] absolute h-full pointer-events-none top-0 border-x border-border-faint">
                  <Connector className="absolute -left-[11.5px] -top-11" />
                  <Connector className="absolute -right-[11.5px] -top-11" />
                </div>

                <motion.div
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, pointerEvents: "none" }}
                  initial={{ opacity: 0 }}
                  transition={{
                    duration: 0.3,
                    ease: cubicBezier(0.4, 0, 0.2, 1),
                  }}
                >
                  {dropdownContent}
                </motion.div>
              </motion.div>
            </AnimatePresence>
          </AnimatedHeight>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
