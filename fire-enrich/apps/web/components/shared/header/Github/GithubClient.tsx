"use client";

import Button from "@/components/shared/button/button";
import GithubIcon from "./_svg/GithubIcon";

export default function HeaderGithubClient() {
  return (
    <a
      className="contents"
      href="https://github.com/firecrawl/firecrawl"
      target="_blank"
    >
      <Button variant="tertiary">
        <GithubIcon />
        21.5k
      </Button>
    </a>
  );
}
