import Image from "@/components/shared/image/Image";

import GithubFlame from "./Flame/Flame";

export default function HeaderDropdownGithub() {
  return (
    <div className="py-24 px-44 border-b border-border-faint relative overflow-clip">
      <div className="size-40 relative mb-17">
        <Image
          alt="Firecrawl icon (blueprint)"
          className="cw-80 ch-80 absolute top-0 left-0 max-w-[unset]"
          height={80}
          src="developer-os-icon"
          width={80}
          raw
        />
      </div>

      <div className="text-label-large">
        Firecrawl is open source. <br />
        Star us to show your support!
      </div>

      <GithubFlame />
    </div>
  );
}
