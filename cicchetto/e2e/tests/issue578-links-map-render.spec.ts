// #578 — the /links map render fix (follow-up to #238). The geometry is
// correct; everything AROUND it was wrong: on a small mesh the labels overlapped
// and the viewBox was sized for a full disc the nodes never filled (a few dots
// on a mostly-black square). The unit tests (linksLayout.test.ts) carry the
// precise fitted-box + angle-anchor + declutter teeth on synthetic dense/chain
// topologies; jsdom is blind to real layout, so THIS e2e asserts the VISIBLE
// outcomes on the live azzurra testnet mesh:
//
//   1. no two RENDERED labels overlap (point 1 — the angle-derived anchor +
//      greedy declutter);
//   2. every rendered label sits fully INSIDE the svg (point 2 — the fitted
//      viewBox now includes each label box; the old full-disc clipped them);
//   3. the colour-ramp legend + the "you are here" root halo are painted
//      (polish 3+4).
//
// The Map BUTTON stays hidden by product decision — the ONLY entry point is the
// `/links` command, so the whole spec drives that path (never a button).

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A screen-space rectangle in the test (Node) context — Playwright's
// boundingBox() returns {x,y,width,height}; DOMRect is a browser global absent
// in Node, so we keep a plain edge-box here.
type Box = { left: number; top: number; right: number; bottom: number };

// Two boxes overlap iff they intersect on BOTH axes (a shared edge/point is not
// an overlap). A small epsilon tolerates sub-pixel touching.
const boxesOverlap = (a: Box, b: Box): boolean => {
  const EPS = 0.5;
  return (
    a.left < b.right - EPS && b.left < a.right - EPS && a.top < b.bottom - EPS && b.top < a.bottom - EPS
  );
};

test("#578 — /links map: no overlapping labels, nothing clipped, legend + you-marker", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Enter the map ONLY via the /links command (the Map button is hidden).
  await composeSend(page, "/links");

  const modal = page.getByTestId("links-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });
  const svg = page.getByTestId("links-modal-svg");
  await expect(svg).toBeVisible();
  await expect(page.getByTestId("links-modal-empty")).toHaveCount(0);

  // A real linked mesh (root + at least its hub).
  const nodes = page.getByTestId("links-modal-node");
  expect(await nodes.count()).toBeGreaterThanOrEqual(2);

  // Point 4 — the root wears a single "you are here" halo ring.
  await expect(page.locator(".links-modal-node-root")).toHaveCount(1);
  await expect(page.locator(".links-modal-you-ring")).toHaveCount(1);

  // Point 3 — the colour-ramp key is painted while a topology is drawn.
  const legend = page.getByTestId("links-modal-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("hops from your server");
  await expect(legend).toContainText("you are here");

  // The rendered label set (each is a <text.links-modal-label>). At least the
  // root label is always drawn; a real mesh draws several.
  const labels = page.locator(".links-modal-label");
  const labelCount = await labels.count();
  expect(labelCount).toBeGreaterThanOrEqual(1);

  const labelRects: Box[] = [];
  for (let i = 0; i < labelCount; i++) {
    const box = await labels.nth(i).boundingBox();
    if (box === null) continue;
    labelRects.push({
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
    });
  }

  // Point 1 — NO two rendered labels overlap (the #578 report showed two piled
  // on the same ray). This is the visible-outcome jsdom cannot see.
  for (let i = 0; i < labelRects.length; i++) {
    for (let j = i + 1; j < labelRects.length; j++) {
      const a = labelRects[i];
      const b = labelRects[j];
      if (a === undefined || b === undefined) continue;
      expect(
        boxesOverlap(a, b),
        `labels ${i} and ${j} overlap — the declutter/anchor fix regressed`,
      ).toBe(false);
    }
  }

  // Point 2 — the fitted viewBox includes each label box, so no label is clipped
  // by the svg edges (the old full-disc glyph-only bound cut outer labels off).
  const svgBox = await svg.boundingBox();
  expect(svgBox).not.toBeNull();
  if (svgBox !== null) {
    const EPS = 1;
    for (const r of labelRects) {
      expect(r.left).toBeGreaterThanOrEqual(svgBox.x - EPS);
      expect(r.top).toBeGreaterThanOrEqual(svgBox.y - EPS);
      expect(r.right).toBeLessThanOrEqual(svgBox.x + svgBox.width + EPS);
      expect(r.bottom).toBeLessThanOrEqual(svgBox.y + svgBox.height + EPS);
    }
  }

  // Dismiss via the × control.
  await page.getByLabel("close links").click();
  await expect(modal).toBeHidden();
});
