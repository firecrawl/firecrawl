import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";

import { getBrandingScript } from "../../../scraper/scrapeURL/engines/fire-engine/brandingScript";

// jsdom has no layout: elements get a box from data-top / data-w / data-h, and
// anything without data-top has an empty box (not visible).
function scan(body: string, scrollY = 0, innerHeight = 1080, bodyAttrs = "") {
  const dom = new JSDOM(
    `<html><head><title>Acme</title></head><body ${bodyAttrs}>${body}</body></html>`,
    { runScripts: "outside-only", url: "https://acme.test/" },
  );
  const window = dom.window as any;
  window.Element.prototype.getBoundingClientRect = function () {
    const top = Number(this.getAttribute?.("data-top") ?? NaN);
    if (Number.isNaN(top)) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
      };
    }
    const width = Number(this.getAttribute("data-w") ?? 160);
    const height = Number(this.getAttribute("data-h") ?? 44);
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      width,
      height,
      right: width,
      bottom: top + height,
    };
  };
  Object.defineProperty(window, "scrollY", { value: scrollY });
  Object.defineProperty(window, "innerHeight", { value: innerHeight });
  const result = window.eval(getBrandingScript());
  return result.branding.snapshots as Array<{
    text: string;
    isButton: boolean;
    isNavigation: boolean;
    visible: boolean;
    position: { top: number };
    colors: { background: string; text: string };
  }>;
}

const byText = (snaps: ReturnType<typeof scan>, text: string) =>
  snaps.find(s => s.text === text);

describe("branding script button detection", () => {
  it("reaches a hero button that comes after many lower buttons in the page", () => {
    const footer = Array.from(
      { length: 160 },
      (_, i) => `<button data-top="${3000 + i * 50}">Footer ${i}</button>`,
    ).join("");
    const snaps = scan(
      `${footer}<main><button data-top="400" style="background-color: rgb(83, 58, 253)">Start free trial</button></main>`,
    );

    const hero = byText(snaps, "Start free trial");
    expect(hero?.isButton).toBe(true);
    expect(hero?.position.top).toBe(400);
  });

  it("keeps a filled call to action in the header nav, but not plain menu links", () => {
    const snaps = scan(
      `<nav data-top="0" data-w="1200" data-h="64">
         <a href="/pricing" data-top="20">Pricing</a>
         <a href="/signup" data-top="20" style="background-color: rgb(255, 90, 0); color: rgb(255, 255, 255); padding: 8px 16px; border-radius: 6px">Sign up</a>
       </nav>`,
    );

    expect(byText(snaps, "Sign up")).toMatchObject({
      isButton: true,
      isNavigation: true,
    });
    expect(byText(snaps, "Pricing")?.isButton).toBe(false);
  });

  it("finds a link whose fill is on an inner element and reports that fill", () => {
    const snaps = scan(
      `<a href="/inspire" data-top="500" data-w="200" data-h="48"><span data-top="500" data-w="200" data-h="48" style="background-color: rgb(34, 34, 34); color: rgb(255, 255, 255)">Get inspired</span></a>`,
    );

    const link = snaps.find(s => s.text === "Get inspired" && s.isButton);
    expect(link?.colors.background).toBe("rgb(34, 34, 34)");
  });

  it("keeps a call to action that is only faded out until it scrolls into view", () => {
    const cta = (text: string) =>
      `<a href="/go" data-top="900" style="background-color: rgb(0, 97, 254); color: rgb(255, 255, 255); padding: 10px 20px; border-radius: 6px">${text}</a>`;
    const snaps = scan(
      // Wix: a box animated in by CSS, sitting at opacity 0 until then.
      `<div style="opacity: 0; animation-name: motion-fadeIn; animation-duration: 1.2s">${cta("Contact us")}</div>
       <!-- Framer: slid out of place by a motion script, inline opacity 0 with a transform. -->
       <div style="will-change: transform; opacity: 0; transform: translateY(44px)">${cta("Book a call")}</div>
       <!-- Shopify theme: a reveal class the page's script flips on scroll. -->
       <section class="tc-row js-reveal" style="opacity: 0">${cta("Shop rugs")}</section>
       <!-- Elementor: visibility hidden until its entrance animation. -->
       <div class="elementor-element elementor-invisible" style="visibility: hidden">${cta("Get a quote")}</div>`,
    );

    for (const text of ["Contact us", "Book a call", "Shop rugs", "Get a quote"]) {
      expect(byText(snaps, text), text).toMatchObject({
        isButton: true,
        visible: true,
      });
    }
  });

  it("still leaves out closed menus, inactive slides and plain transparent boxes", () => {
    const cta = (text: string) =>
      `<a href="/go" data-top="300" style="background-color: rgb(0, 97, 254); color: rgb(255, 255, 255); padding: 10px 20px; border-radius: 6px">${text}</a>`;
    const snaps = scan(
      `<div style="opacity: 0; position: absolute; transition-property: opacity; transition-duration: 0.3s">${cta("Menu item")}</div>
       <!-- A closed accordion in normal flow fades too: a transition is not an entrance. -->
       <div style="opacity: 0; transition-property: opacity; transition-duration: 0.3s">${cta("Accordion item")}</div>
       <div style="opacity: 0; will-change: transform">${cta("Will change only")}</div>
       <div style="opacity: 0; position: relative" aria-hidden="true">${cta("Slide two")}</div>
       <div style="opacity: 0">${cta("Just transparent")}</div>
       <div style="opacity: 0; position: fixed; transform: translateY(-100%); pointer-events: none">${cta("Filter bar")}</div>
       <!-- A dialog closed for good, with an entrance-animated box inside it. -->
       <div style="visibility: hidden"><div class="elementor-invisible" style="visibility: hidden">${cta("Inside closed dialog")}</div></div>`,
    );

    // Links are sampled for typography regardless, so they appear in the
    // snapshots; what matters is that none of them counts as visible.
    for (const text of [
      "Menu item",
      "Accordion item",
      "Will change only",
      "Slide two",
      "Just transparent",
      "Filter bar",
      "Inside closed dialog",
    ]) {
      expect(byText(snaps, text)?.visible, text).toBe(false);
    }
  });

  it("ignores a load-time fade on the page itself", () => {
    const snaps = scan(
      `<button data-top="400" style="background-color: rgb(83, 58, 253); color: rgb(255, 255, 255)">Start free trial</button>`,
      0,
      1080,
      'style="opacity: 0"',
    );

    expect(byText(snaps, "Start free trial")).toMatchObject({
      isButton: true,
      visible: true,
    });
  });

  it("reports the label's color when the button's own color is only inherited", () => {
    const snaps = scan(
      `<button data-top="500" style="background-color: rgb(0, 0, 0); color: rgb(0, 0, 0)"><span style="color: rgb(255, 255, 255)">Subscribe Now</span></button>
       <a href="/plain" data-top="600" style="background-color: rgb(0, 97, 254); color: rgb(255, 255, 255); padding: 8px 16px; border-radius: 6px">Plain label</a>
       <button data-top="700" style="background-color: rgb(0, 0, 0); color: rgb(0, 0, 0)"><span style="display: none; color: rgb(255, 0, 0)">Mobile copy</span><span class="sr-only" style="position: absolute; width: 1px; height: 1px; color: rgb(0, 255, 0)">Opens in a new tab</span><span style="color: rgb(255, 255, 255)">Desktop label</span></button>`,
    );

    expect(byText(snaps, "Subscribe Now")?.colors).toMatchObject({
      background: "rgb(0, 0, 0)",
      text: "rgb(255, 255, 255)",
    });
    // Hidden copies for other breakpoints or screen readers are passed over.
    expect(
      snaps.find(s => s.text.startsWith("Mobile copy"))?.colors.text,
    ).toBe("rgb(255, 255, 255)");
    expect(byText(snaps, "Plain label")?.colors.text).toBe("rgb(255, 255, 255)");
  });

  it("still reads the label inside a button waiting on its entrance animation", () => {
    const snaps = scan(
      `<div class="elementor-element elementor-invisible" style="visibility: hidden">
         <a href="/quote" data-top="800" class="elementor-button" style="background-color: rgb(200, 30, 30); color: rgb(0, 0, 0); padding: 10px 20px; border-radius: 4px"><span class="elementor-button-text" style="color: rgb(255, 255, 255)">Get a quote</span></a>
       </div>`,
    );

    expect(byText(snaps, "Get a quote")).toMatchObject({
      isButton: true,
      visible: true,
      colors: { background: "rgb(200, 30, 30)", text: "rgb(255, 255, 255)" },
    });
  });

  it("leaves out hidden copies of buttons", () => {
    const snaps = scan(
      `<button data-top="300" style="display: none">Hidden menu CTA</button><div data-top="300" style="opacity: 0"><button data-top="300">Faded menu CTA</button></div><button data-top="300">Shown CTA</button>`,
    );

    expect(byText(snaps, "Hidden menu CTA")).toBeUndefined();
    expect(byText(snaps, "Faded menu CTA")).toBeUndefined();
    expect(byText(snaps, "Shown CTA")?.visible).toBe(true);
  });

  it("keeps a fixed header button at its on-screen position after scrolling", () => {
    const snaps = scan(
      `<header style="position: fixed" data-top="0" data-w="1200" data-h="64"><button data-top="10">Sign up</button></header>
       <button data-top="100">Read more</button>`,
      800,
    );

    expect(byText(snaps, "Sign up")?.position.top).toBe(10);
    expect(byText(snaps, "Read more")?.position.top).toBe(900);
  });

  it("reports positions in a very tall window as they would be on a screen", () => {
    // A hero sized to the window is as tall as it, with its centered button
    // halfway down.
    const snaps = scan(
      `<section data-top="0" data-w="1920" data-h="100000">
         <button data-top="40">Log in</button>
         <button data-top="50000">Start free trial</button>
       </section>
       <section data-top="100000" data-w="1920" data-h="2000">
         <button data-top="100400">Read the docs</button>
       </section>
       <div style="position: fixed" data-top="50000" data-w="600" data-h="300">
         <button data-top="50100">Accept</button>
       </div>
       <div style="position: fixed" data-top="900" data-w="600" data-h="60">
         <button data-top="900">Chat with us</button>
       </div>`,
      0,
      100_000,
    );

    expect(byText(snaps, "Log in")?.position.top).toBe(40);
    expect(byText(snaps, "Start free trial")?.position.top).toBeCloseTo(540, 0);
    expect(byText(snaps, "Read the docs")?.position.top).toBeCloseTo(1480, 0);
    expect(byText(snaps, "Accept")?.position.top).toBeCloseTo(541, 0);
    // Fixed in pixels, not by the window's height: kept as is.
    expect(byText(snaps, "Chat with us")?.position.top).toBe(900);
  });
});
