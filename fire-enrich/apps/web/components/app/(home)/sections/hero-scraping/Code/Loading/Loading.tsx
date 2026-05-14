import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { encryptText } from "@/components/app/(home)/sections/hero/Title/Title";
import AnimatedWidth from "@/components/shared/layout/animated-width";
import Spinner from "@/components/ui/spinner";

export default function HeroScrapingCodeLoading({
  finished,
}: {
  finished: boolean;
}) {
  const [scrapingText, setScrapingText] = useState("Scraping...");

  useEffect(() => {
    if (finished) return;

    let timeout = 0;
    let tick = 0;

    const animate = () => {
      tick += 1;

      if (tick % 3 !== 0) {
        setScrapingText(
          encryptText("Scraping", 0, {
            randomizeChance: 0.6 + Math.random() * 0.3,
          }) + "...",
        );
      } else {
        setScrapingText("Scraping...");
      }

      const interval = 80;
      timeout = window.setTimeout(animate, interval);
    };

    animate();

    return () => {
      window.clearTimeout(timeout);
    };
  }, [finished]);

  return (
    <div className="flex gap-6 p-6 pr-0 rounded-full before:inside-border before:border-border-faint absolute right-20 bottom-20 text-mono-small text-accent-black">
      <Spinner finished={finished} />

      <AnimatedWidth initial={{ width: "auto" }}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            animate={{ opacity: 1, x: 0 }}
            className="pr-12"
            exit={{ opacity: 0, x: 10 }}
            initial={{ opacity: 0, x: -10 }}
          >
            {finished ? "Scrape Completed" : scrapingText}
          </motion.div>
        </AnimatePresence>
      </AnimatedWidth>
    </div>
  );
}
