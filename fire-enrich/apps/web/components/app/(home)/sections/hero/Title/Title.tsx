"use client";

// import dynamic from "next/dynamic";
// import { useRef, useEffect, forwardRef } from "react";

// const originalText =
//   "";

type Options = {
  randomizeChance?: number;
  reversed?: boolean;
};

export const encryptText = (
  text: string,
  progress: number,
  _options?: Options,
) => {
  const options = {
    randomizeChance: 0.7,
    ..._options,
  };

  const encryptionChars = "a-zA-Z0-9*=?!";
  const skipTags = ["<br class='lg-max:hidden'>", "<span>", "</span>"];

  // Calculate how many characters should be encrypted
  const totalChars = text.length;
  const encryptedCount = Math.floor(totalChars * (1 - progress));

  let result = "";
  let charIndex = 1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Check if we're at the start of a tag to skip
    let shouldSkip = false;

    for (const tag of skipTags) {
      if (text.substring(i, i + tag.length) === tag) {
        result += tag;
        i += tag.length - 1; // -1 because loop will increment
        shouldSkip = true;
        break;
      }
    }

    if (shouldSkip) continue;

    // Skip spaces - keep them as is
    if (char === " ") {
      result += char;
      charIndex++;
      continue;
    }

    // If this character should be encrypted
    if (
      options.reversed
        ? charIndex < encryptedCount
        : text.length - charIndex < encryptedCount
    ) {
      // 40% chance to show original character, 60% chance to encrypt
      if (Math.random() < options.randomizeChance) {
        result += char;
      } else {
        // Use random character from encryption set
        const randomIndex = Math.floor(Math.random() * encryptionChars.length);
        result += encryptionChars[randomIndex];
      }
    } else {
      // Keep original character
      result += char;
    }

    charIndex++;
  }

  return result;
};

// const Wrapper = forwardRef<
//   HTMLDivElement,
//   React.HTMLAttributes<HTMLDivElement>
// >((props, ref) => {
//   return (
//     <div className="text-title-h1 mx-auto text-center [&_span]:text-heat-100 mb-12 lg:mb-16">
//       <div {...props} className="hidden lg:contents" ref={ref} />
//       <div
//         className="lg:hidden contents"
//         dangerouslySetInnerHTML={{ __html: originalText }}
//       />
//     </div>
//   );
// });

// Wrapper.displayName = "Wrapper";

// export default dynamic(() => Promise.resolve(HomeHeroTitle), {
//   ssr: false,
//   loading: () => (
//     <Wrapper
//       dangerouslySetInnerHTML={{ __html: encryptText(originalText, 0) }}
//     />
//   ),
// });

// function HomeHeroTitle() {
//   const textRef = useRef<HTMLDivElement>(null);

//   useEffect(() => {
//     if (window.innerWidth < 996) {
//       return;
//     }

//     let progress = 0;
//     let increaseProgress = -10;

//     const animate = () => {
//       increaseProgress = (increaseProgress + 1) % 5;

//       if (increaseProgress === 4) {
//         progress += 0.3;
//       }

//       if (progress > 1) {
//         progress = 1;
//         textRef.current!.innerHTML = encryptText(originalText, progress);

//         return;
//       }

//       textRef.current!.innerHTML = encryptText(originalText, progress);

//       const interval = 50 + progress * 20;
//       setTimeout(animate, interval);
//     };

//     animate();
//   }, []);

//   return (
//     <Wrapper
//       dangerouslySetInnerHTML={{ __html: encryptText(originalText, 0) }}
//       ref={textRef}
//     />
//   );
// }

// import dynamic from "next/dynamic";
// import { useRef, useEffect, forwardRef } from "react";

// const originalText =
//   "Turn websites into <br class='lg-max:hidden'><span>LLM-ready</span> data";

// type Options = {
//   randomizeChance?: number;
//   reversed?: boolean;
// };

// export const encryptText = (
//   text: string,
//   progress: number,
//   _options?: Options,
// ) => {
//   const options = {
//     randomizeChance: 0.7,
//     ..._options,
//   };

//   const encryptionChars = "a-zA-Z0-9*=?!";
//   const skipTags = ["<br class='lg-max:hidden'>", "<span>", "</span>"];

//   // Calculate how many characters should be encrypted
//   const totalChars = text.length;
//   const encryptedCount = Math.floor(totalChars * (1 - progress));

//   let result = "";
//   let charIndex = 1;

//   for (let i = 0; i < text.length; i++) {
//     const char = text[i];

//     // Check if we're at the start of a tag to skip
//     let shouldSkip = false;

//     for (const tag of skipTags) {
//       if (text.substring(i, i + tag.length) === tag) {
//         result += tag;
//         i += tag.length - 1; // -1 because loop will increment
//         shouldSkip = true;
//         break;
//       }
//     }

//     if (shouldSkip) continue;

//     // Skip spaces - keep them as is
//     if (char === " ") {
//       result += char;
//       charIndex++;
//       continue;
//     }

//     // If this character should be encrypted
//     if (
//       options.reversed
//         ? charIndex < encryptedCount
//         : text.length - charIndex < encryptedCount
//     ) {
//       // 40% chance to show original character, 60% chance to encrypt
//       if (Math.random() < options.randomizeChance) {
//         result += char;
//       } else {
//         // Use random character from encryption set
//         const randomIndex = Math.floor(Math.random() * encryptionChars.length);
//         result += encryptionChars[randomIndex];
//       }
//     } else {
//       // Keep original character
//       result += char;
//     }

//     charIndex++;
//   }

//   return result;
// };

// const Wrapper = forwardRef<
//   HTMLDivElement,
//   React.HTMLAttributes<HTMLDivElement>
// >((props, ref) => {
//   return (
//     <div className="text-title-h1 mx-auto text-center [&_span]:text-heat-100 mb-12 lg:mb-16">
//       <div {...props} className="hidden lg:contents" ref={ref} />
//       <div
//         className="lg:hidden contents"
//         dangerouslySetInnerHTML={{ __html: originalText }}
//       />
//     </div>
//   );
// });

// Wrapper.displayName = "Wrapper";

// export default dynamic(() => Promise.resolve(HomeHeroTitle), {
//   ssr: false,
//   loading: () => (
//     <Wrapper
//       dangerouslySetInnerHTML={{ __html: encryptText(originalText, 0) }}
//     />
//   ),
// });

export default function HomeHeroTitle() {
  return (
    <div className="text-title-h1 mx-auto text-center [&_span]:text-heat-100 mb-12 lg:mb-16">
      Fire Enrich v2 <br />
      <span>Drag, Drop, Enrich</span>
    </div>
  );
}
