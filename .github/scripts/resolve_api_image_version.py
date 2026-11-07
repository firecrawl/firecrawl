#!/usr/bin/env python3
"""Resolve the next deployable API image version.

Deploy image versions are full SemVer Git tags: vX.Y.Z. Existing two-part
marketing release tags such as v2.10 are treated as v2.10.0 bases.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass


VERSION_TAG_RE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$")


@dataclass(frozen=True)
class SemverTag:
    name: str
    version: tuple[int, int, int]
    commit: str


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def list_semver_tags() -> list[SemverTag]:
    raw_tags = git("tag", "--list", "v*").splitlines()
    tags: list[SemverTag] = []

    for tag in raw_tags:
        match = VERSION_TAG_RE.match(tag)
        if not match:
            continue

        major, minor, patch = match.groups()
        commit = git("rev-list", "-n", "1", tag)
        tags.append(
            SemverTag(
                name=tag,
                version=(int(major), int(minor), int(patch or 0)),
                commit=commit,
            )
        )

    return sorted(tags, key=lambda item: item.version)


def bump_version(base: tuple[int, int, int] | None, bump: str) -> tuple[int, int, int]:
    if base is None:
        return (0, 1, 0) if bump == "minor" else (0, 0, 1)

    major, minor, patch = base
    if bump == "minor":
        return (major, minor + 1, 0)

    return (major, minor, patch + 1)


def write_output(name: str, value: str) -> None:
    print(f"{name}={value}")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as output:
            output.write(f"{name}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bump", choices=["patch", "minor"], default="patch")
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA", "HEAD"))
    parser.add_argument("--image-name", default="firecrawl")
    parser.add_argument(
        "--include-current-commit-tags",
        action="store_true",
        help="Use the highest SemVer tag even when it already points at --sha.",
    )
    args = parser.parse_args()

    current_sha = git("rev-parse", args.sha)
    short_sha = git("rev-parse", "--short=12", current_sha)
    semver_tags = list_semver_tags()

    if args.include_current_commit_tags:
        base_tags = semver_tags
    else:
        # Excluding tags already on this commit makes production retries
        # idempotent. If a prior attempt created vX.Y.Z but failed before
        # pushing every manifest, the same target version is reused instead of
        # burning vX.Y.(Z+1).
        base_tags = [tag for tag in semver_tags if tag.commit != current_sha]

    base = base_tags[-1].version if base_tags else None
    version = bump_version(base, args.bump)
    tag_name = f"v{version[0]}.{version[1]}.{version[2]}"

    existing_target = next((tag for tag in semver_tags if tag.name == tag_name), None)
    if existing_target and existing_target.commit != current_sha:
        print(
            f"Resolved tag {tag_name} already exists on {existing_target.commit}, "
            f"not {current_sha}",
            file=sys.stderr,
        )
        return 1

    repo_owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "firecrawl").lower()
    image = f"ghcr.io/{repo_owner}/{args.image_name}"
    version_text = ".".join(str(part) for part in version)

    write_output("version", version_text)
    write_output("tag", tag_name)
    write_output("tag_exists", "true" if existing_target else "false")
    write_output("major", str(version[0]))
    write_output("minor", str(version[1]))
    write_output("major_minor", f"{version[0]}.{version[1]}")
    write_output("short_sha", short_sha)
    write_output("image", image)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
