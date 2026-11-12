// issue 2486 / issue 2641 — the geometry the pane's pinned band is held to on
// a phone: whatever it pins at the top of the pane must keep its text and its
// controls clear of the corner floats `.shell-chrome` mounts there (the ☰ at
// z-index 41, #985, and the left `#` door while the window bar is off, #1766).
// One rule in the theme, so one set of helpers rather than a copy per spec —
// the same argument `railFieldGeometry.ts` makes.
//
// The oracle has to be a real engine: jsdom lays nothing out and ingests no
// theme declaration (`feedback_vitest_jsdom_cannot_observe_cic_css_at_all`).

import type { Locator } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

export async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("cornerFloats — a measured element has no bounding box");
  return b;
}

/** True iff the two boxes share any area. Touching edges do not meet. */
export function meet(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True iff `locator` is the topmost element at its own centre. */
export async function onTop(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top === el || el.contains(top);
  });
}
