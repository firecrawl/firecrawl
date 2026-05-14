import Link from "next/link";

export default function HomeHeroBadge() {
  return (
    <Link
      className="p-4 rounded-full flex w-max mx-auto mb-12 lg:mb-16 items-center relative before:inside-border before:border-border-faint group"
      href="#"
      onClick={(e) => e.preventDefault()}
    >
      <div className="px-8 text-label-x-small">AI Lead Enrichment</div>

      <div className="p-1">
        <div className="size-18 bg-accent-black flex-center rounded-full group-hover:bg-heat-100 transition-all group-hover:w-30">
          <svg
            fill="none"
            height="8"
            viewBox="0 0 10 8"
            width="10"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              className="transition-all -translate-x-2 group-hover:translate-x-0"
              d="M6 1L9 4L6 7"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.25"
            />

            <path
              className="transition-all -translate-x-3 group-hover:translate-x-0 scale-x-[0] group-hover:scale-x-[1] origin-right"
              d="M1 4L9 4"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.25"
            />
          </svg>
        </div>
      </div>
    </Link>
  );
}
