import { HTMLAttributes } from "react";

export default function BrowserTab(attrs: HTMLAttributes<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      height="36"
      viewBox="0 0 226 36"
      width="226"
      xmlns="http://www.w3.org/2000/svg"
      {...attrs}
    >
      <path
        d="M0 35C5.52285 35 10 30.5228 10 25V11C10 5.47715 14.4772 1 20 1H206C211.523 1 216 5.47715 216 11V25C216 30.5228 220.477 35 226 35"
        stroke="#E8E8E8"
      />
    </svg>
  );
}
