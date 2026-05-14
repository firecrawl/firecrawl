"use client";

import { Fragment } from "react";

import CurvyRect from "@/components/shared/layout/curvy-rect";

import CenterStar from "./_svg/CenterStar";

export default function HomeHeroBackground() {
  return (
    <div className="overlay contain-layout pointer-events-none lg-max:hidden">
      <div className="top-100 h-[calc(100%-99px)] border-border-faint border-y w-full left-0 absolute" />
      <div className="cw-[1314px] z-[45] absolute top-0 border-x border-border-faint h-full">
        <div className="text-mono-x-small text-black-alpha-12 select-none">
          <div className="absolute top-111 -left-1 w-102 text-center">
            {" "}
            [ 200 OK ]{" "}
          </div>

          <div className="absolute bottom-10 -left-1 w-102 text-center">
            {" "}
            [ .JSON ]{" "}
          </div>

          <div className="absolute top-111 -right-1 w-102 text-center">
            {" "}
            [ SCRAPE ]{" "}
          </div>
          <div className="absolute bottom-10 -right-1 w-102 text-center">
            {" "}
            [ .MD ]{" "}
          </div>
        </div>

        <div className="top-302 h-1 left-0 bg-border-faint w-303 absolute" />
        <div className="top-403 h-1 left-0 bg-border-faint w-303 absolute" />
        <div className="top-504 h-1 left-100 bg-border-faint w-203 absolute" />

        <div className="top-302 h-1 right-0 bg-border-faint w-303 absolute" />
        <div className="top-403 h-1 right-0 bg-border-faint w-303 absolute" />
        <div className="top-504 h-1 right-100 bg-border-faint w-203 absolute" />

        {Array.from({ length: 2 }, (_, i) => (
          <Fragment key={i}>
            <CurvyRect
              bottomLeft={i === 1}
              bottomRight={i === 0}
              className="w-101  h-[calc(100%-99px)] top-100 absolute"
              style={{ [i === 0 ? "left" : "right"]: -101 }}
            />

            <CurvyRect
              className="w-102 h-203 top-100 absolute"
              style={{ [i === 0 ? "left" : "right"]: -1 }}
              allSides
            />
            <CurvyRect
              className="size-102 top-302 absolute"
              style={{ [i === 0 ? "left" : "right"]: -1 }}
              allSides
            />
            <CurvyRect
              className="w-102 h-203 top-403 absolute"
              style={{ [i === 0 ? "left" : "right"]: -1 }}
              allSides
            />
          </Fragment>
        ))}
      </div>

      <div className="cw-[910px] absolute top-100 border-x border-border-faint h-[calc(100%-99px)]" />
      <div className="cw-[708px] absolute top-100 border-x border-border-faint h-[calc(100%-99px)]">
        <CenterStar className="absolute top-77 -right-24 z-[1]" />
        <CenterStar className="absolute top-77 -left-24 z-[1]" />
      </div>

      <CurvyRect
        className="cw-[708px] absolute top-100 h-[calc(100%-99px)]"
        bottom
      />

      <div className="cw-[506px] absolute top-100 border-x border-border-faint h-102" />
      <div className="cw-[304px] absolute top-100 border-x border-border-faint h-102" />
      <div className="cw-[102px] absolute top-100 border-x border-border-faint h-102" />

      <div className="top-201 h-1 bg-border-faint cw-[1112px] absolute" />

      <div className="cw-[1112px] absolute top-0 h-full">
        <CurvyRect className="w-full absolute top-full h-100 left-0" top />
        <CurvyRect
          className="w-100 absolute top-full h-100 -left-99"
          topRight
        />
        <CurvyRect
          className="w-100 absolute top-full h-100 -right-99"
          topLeft
        />

        {Array.from({ length: 5 }, (_, i) => (
          <Fragment key={i}>
            <CurvyRect
              className="size-102 absolute left-0"
              style={{
                top: 100 + i * 101,
              }}
              allSides
            />

            <CurvyRect
              className="size-102 absolute right-0"
              style={{
                top: 100 + i * 101,
              }}
              allSides
            />
          </Fragment>
        ))}

        <CurvyRect
          className="size-102 absolute left-101 top-100"
          bottomLeft
          top
        />
        <CurvyRect
          className="size-102 absolute left-101 top-201"
          bottom
          topLeft
        />

        <CurvyRect
          className="size-102 absolute right-101 top-100"
          bottomRight
          top
        />
        <CurvyRect
          className="size-102 absolute right-101 top-201"
          bottom
          topRight
        />

        {Array.from({ length: 3 }, (_, i) => (
          <Fragment key={i}>
            <CurvyRect
              className="size-102 absolute left-101"
              style={{
                top: 302 + i * 101,
              }}
              allSides
            />

            <CurvyRect
              className="size-102 absolute right-101"
              style={{
                top: 302 + i * 101,
              }}
              allSides
            />
          </Fragment>
        ))}

        <CurvyRect
          className="size-102 absolute top-100 left-202"
          bottomRight
          top
        />

        {Array.from({ length: 5 }, (_, i) => (
          <CurvyRect
            className="size-102 absolute top-100"
            key={i}
            style={{ left: 303 + i * 101 }}
            allSides
          />
        ))}

        <CurvyRect
          className="size-102 absolute top-100 right-202"
          bottomLeft
          top
        />
      </div>
    </div>
  );
}
