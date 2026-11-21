import { describe, expect, it } from "vitest";
import {
  allRules,
  isZeroInset,
  mediaGatedBlocks,
  selectorList,
  themeCss,
} from "./helpers/themeCss";

// issue 2647 — the login backdrop's three drift layers animated
// `background-position`. That property is painted, not composited: every frame
// repaints the whole layer on the renderer's main thread. The same backdrop on
// the grappa.chat home page put a Chrome renderer at 300% CPU (grappa-www
// e40ce13). The cure moves each layer with `transform` instead, which the
// compositor takes over from a layer painted once.
//
// These read the stylesheet's SOURCE. jsdom ingests none of the theme, so no
// computed style or paint can be observed here; what CAN be held is the shape
// the cure depends on, at the level of the whole backdrop rather than of the
// three declarations the cure happens to write.

/** Every rule that styles the backdrop element, its pseudo-elements, or a child. */
function backdropRules(): { selectors: string[]; body: string }[] {
  return allRules()
    .map((rule) => ({ selectors: selectorList(rule.selectors), body: rule.body }))
    .filter((rule) => rule.selectors.some((one) => /^\.login-matrix\b/.test(one)));
}

/** The value of `property` in a rule body, or undefined. Last one wins, as in the cascade. */
function declared(body: string, property: string): string | undefined {
  let found: string | undefined;
  for (const raw of body.split(";")) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    if (raw.slice(0, colon).trim() === property) found = raw.slice(colon + 1).trim();
  }
  return found;
}

/**
 * The value of `property` on `selector`, across every backdrop rule whose
 * selector list names it: a layer's own rule and the rule it shares with the
 * other layers. Every candidate names the SAME selector, so specificity ties
 * and source order decides, as here.
 */
function cascaded(selector: string, property: string): string | undefined {
  let found: string | undefined;
  for (const rule of backdropRules()) {
    if (rule.selectors.includes(selector)) found = declared(rule.body, property) ?? found;
  }
  return found;
}

const keyframeNames = new Set([...themeCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));

/** The keyframe set a rule body runs, if it runs one the sheet defines. */
function animationOf(body: string): string | undefined {
  const value = declared(body, "animation") ?? declared(body, "animation-name");
  return value?.split(/[\s,]+/).find((token) => keyframeNames.has(token));
}

/** The backdrop rules that run an animation, with the keyframe set each one runs. */
function driftLayers(): { selectors: string[]; body: string; keyframes: string }[] {
  const out: { selectors: string[]; body: string; keyframes: string }[] = [];
  for (const rule of backdropRules()) {
    const keyframes = animationOf(rule.body);
    if (keyframes !== undefined) out.push({ ...rule, keyframes });
  }
  return out;
}

/** The frames of one `@keyframes` block, as `{ selector, body }` pairs. */
function frames(name: string): { selector: string; body: string }[] {
  const [block] = mediaGatedBlocks(
    new RegExp(`@keyframes ${name}\\s*\\{`, "g"),
    `@keyframes ${name}`,
  );
  return [...(block ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
  }));
}

/** The property names a rule body declares. */
function properties(body: string): string[] {
  return body
    .split(";")
    .map((raw) => raw.slice(0, raw.indexOf(":")).trim())
    .filter((property) => property !== "");
}

/** The length in px a `NNNpx` token carries. */
const px = (token: string | undefined): number | undefined => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(token ?? "");
  return m ? Number(m[1]) : undefined;
};

describe("the login backdrop drifts on the compositor (issue 2647)", () => {
  it("animates nothing but transform and opacity, on any of its layers", () => {
    const layers = driftLayers();
    // Far, mid and near: the parallax is three layers. Counting them first
    // keeps the census below from passing because it found nothing to census.
    expect(new Set(layers.map((layer) => layer.keyframes)).size).toBe(3);
    const painted: string[] = [];
    for (const layer of layers) {
      for (const frame of frames(layer.keyframes)) {
        for (const property of properties(frame.body)) {
          if (property !== "transform" && property !== "opacity") {
            painted.push(`${layer.keyframes} ${frame.selector}: ${property}`);
          }
        }
      }
    }
    expect(painted, "keyframes that repaint the layer on every frame").toEqual([]);
  });

  it("moves every layer exactly one tile, from one tile above, so the loop is seamless", () => {
    // The numbers must agree. A tile resized without its travel jumps once per
    // loop; an overhang shorter than the travel uncovers a strip of bare
    // background at the top as the layer slides down; a bottom edge above the
    // backdrop's leaves one at the bottom at the start of every loop.
    for (const layer of driftLayers()) {
      // The height of the FIRST background layer: the stripes the tile repeats.
      const tile = px(
        declared(layer.body, "background-size")?.split(",")[0]?.trim().split(/\s+/).at(-1),
      );
      const travel = frames(layer.keyframes)
        .filter((frame) => frame.selector === "to")
        .map((frame) => /translateY\(([^)]*)\)/.exec(declared(frame.body, "transform") ?? "")?.[1])
        .map(px)[0];
      const where = `${layer.selectors.join(", ")} (${layer.keyframes})`;
      expect(tile, `${where}: tile height`).toBeGreaterThan(0);
      expect(travel, `${where}: travel`).toBe(tile);
      for (const selector of layer.selectors) {
        expect(px(cascaded(selector, "top")), `${selector}: overhang`).toBe(-(tile ?? 0));
        expect(cascaded(selector, "bottom"), `${selector}: bottom edge`).toSatisfy(
          (bottom: string | undefined) => bottom !== undefined && isZeroInset(bottom),
        );
      }
    }
  });

  it("keeps the glow on a box that nothing moves", () => {
    // Under `transform` a layer carries everything painted on it, so the
    // radial glow behind the card would drift with whichever layer held it.
    const moving = driftLayers().filter((layer) =>
      /radial-gradient/.test(declared(layer.body, "background-image") ?? ""),
    );
    expect(moving.map((layer) => layer.selectors.join(", "))).toEqual([]);
    // ...and the glow is still there, or the line above has nothing to say.
    const still = backdropRules().filter(
      (rule) =>
        animationOf(rule.body) === undefined &&
        /radial-gradient/.test(declared(rule.body, "background-image") ?? ""),
    );
    expect(still).toHaveLength(1);
  });

  it("freezes every drift layer under prefers-reduced-motion", () => {
    const frozen = mediaGatedBlocks(
      /@media \(prefers-reduced-motion: reduce\) \{/g,
      "reduced-motion",
    )
      .flatMap((block) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
      .filter((m) => declared(m[2] ?? "", "animation") === "none")
      .flatMap((m) => selectorList(m[1] ?? ""));
    const layers = driftLayers().flatMap((layer) => layer.selectors);
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.filter((selector) => !frozen.includes(selector))).toEqual([]);
  });
});
