import { motion } from "motion/react";
import { ComponentProps, useEffect, useState } from "react";

import { encryptText } from "@/components/app/(home)/sections/hero/Title/Title";
import { cn } from "@/utils/cn";

export default function HeroScrapingTag({
  active,
  label,
  ...attrs
}: ComponentProps<typeof motion.div> & { active?: boolean; label: string }) {
  const [value, setValue] = useState(
    encryptText(label, 0, { randomizeChance: 0 }),
  );

  useEffect(() => {
    let progress = 0;
    let increaseProgress = -10;

    const animate = () => {
      increaseProgress = (increaseProgress + 1) % 5;

      if (increaseProgress === 4) {
        progress += 0.2;
      }

      if (progress > 1) {
        progress = 1;
        setValue(encryptText(label, progress, { randomizeChance: 0 }));

        return;
      }

      setValue(encryptText(label, progress, { randomizeChance: 0 }));

      const interval = 40 + progress * 20;
      setTimeout(animate, interval);
    };

    animate();
  }, []);

  return (
    <motion.div
      {...attrs}
      animate={{
        x: 0,
        y: 0,
        scale: 1,
        opacity: 1,
        filter: "blur(0px)",
      }}
      className={cn(
        "py-4 h-max w-max px-6 text-mono-x-small rounded-6 transition-colors",
        active
          ? "bg-heat-12 text-heat-100"
          : "bg-black-alpha-4 text-black-alpha-56",
        attrs.className,
      )}
      transition={{
        type: "spring",
        stiffness: 100,
        damping: 18,
      }}
    >
      {value}
    </motion.div>
  );
}
