"use client";

import { Suspense, lazy, useState, useEffect } from "react";

const Pixi = lazy(() => import("@/components/shared/pixi/Pixi"));
import features from "./tickers/features";

function PixiContent() {
  return (
    <Pixi
      canvasAttrs={{
        className: "cw-[1314px] h-506 absolute top-100 lg-max:hidden",
      }}
      fps={Infinity}
      initOptions={{ backgroundAlpha: 0 }}
      smartStop={false}
      tickers={[features]}
    />
  );
}

export default function HomeHeroPixi() {
  const [hasError, setHasError] = useState(false);
  
  useEffect(() => {
    const handleError = (e: ErrorEvent) => {
      if (e.message.includes('pixi') || e.message.includes('ChunkLoadError')) {
        setHasError(true);
      }
    };
    
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);
  
  if (hasError) {
    // Return empty div as fallback if Pixi fails to load
    return <div className="cw-[1314px] h-506 absolute top-100 lg-max:hidden" />;
  }
  
  return (
    <Suspense fallback={<div className="cw-[1314px] h-506 absolute top-100 lg-max:hidden" />}>
      <PixiContent />
    </Suspense>
  );
}
