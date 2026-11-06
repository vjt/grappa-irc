// issue 2506 — the encrypted query's rail (EncryptedRail under the query
// context, issue 2499), two things vjt saw on his phone:
//   1. its buttons (`pin`, `copy your key`, `add a device`) much taller than
//      one line needs, against the `paste their key` input beside `pin`;
//   2. the peer's WHOIS card under the key sections with a left edge of its
//      own, further in than the peer card and `your identity`.
//
// Measured first (CI, this spec's red run): on desktop chromium, Pixel 7 and
// iPhone 15 WebKit the input and all three buttons were exactly 44.0px, the
// --tap-min floor (#306) that both carried, and the WHOIS card sat 7px (its
// 0.5rem margin) inside the key sections on both sides. vjt's ruling on the
// first point: the buttons are sized to their content, the input keeps its
// 44px, and `pin`, on the input's row, takes the input's height. Issue 2544
// took the input and `pin` away with the form that pasted a key; the verify
// button that replaced them shows only beside a key taken, which the plain
// IRC peer here never sends, and shares the rail's button rule with the two
// measured.
//
// Asserted as the geometry a person reads, on the desktop rail and in the
// phone drawer:
//   * `copy your key` and `add a device` are one line of text, and their
//     content box no taller than that line (no floor holding them open);
//   * the WHOIS card's left and right edges are the key sections' own.
// Every measured box is attached to the run, so a red says by how much.
//
// ## What makes this spec able to fail
//
//   * A floor comes back on the rail's buttons (44px for a 14px line).
//   * A label wraps to a second line.
//   * The WHOIS card keeps a horizontal margin the rail's cards do not have.

import type { Locator, Page, TestInfo } from "@playwright/test";
import { openMembersDrawer } from "../fixtures/cicchettoPage";
import { boot, equery } from "../fixtures/encryptedQuery";
import { IrcPeer } from "../fixtures/ircClient";
import { expect, specNick, specUser, test } from "../fixtures/test";

type Box = {
  left: number;
  right: number;
  height: number;
  /** Height inside padding and border: what the content holds open. */
  content: number;
  fontSize: number;
  /** Line boxes of the element's text. */
  lines: number;
};

// Every box read in one call, but that alone does not keep a sliding drawer's
// edges together (issue 2532). Twice red on webkit-iphone-15 (main at
// 24f745040, run 41611248751; PR 2526, run 41887787807): the peer card's left
// edge at 251.2px and 193.0px, the drawer still on its way in, and the peer
// card, the box read FIRST, 1.48px and 1.08px right of `own` and the WHOIS
// card, which agreed with each other exactly: consistent with the slide
// moving between two reads of one evaluate on WebKit. So the phone test
// measures only once the drawer has stopped (see there); the single call
// stays as one round trip and one attachment.
const RAIL_PARTS = {
  peer: '[data-testid="e2e-rail-peer"]',
  own: '[data-testid="e2e-rail-own"]',
  whois: '[data-testid="rail-query-context"] [data-testid="whois-card"]',
  copy: '[data-testid="e2e-own-identity-copy"]',
  addDevice: '[data-testid="e2e-add-device"]',
} as const;

const railBoxes = (r: Locator): Promise<Record<keyof typeof RAIL_PARTS, Box>> =>
  r.evaluate((root, parts) => {
    const out: Record<string, Box> = {};
    for (const [name, sel] of Object.entries(parts)) {
      const el = root.querySelector(sel);
      if (el === null) throw new Error(`the rail has no ${sel}`);
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const px = (v: string) => Number.parseFloat(v) || 0;
      const content =
        b.height -
        px(cs.paddingTop) -
        px(cs.paddingBottom) -
        px(cs.borderTopWidth) -
        px(cs.borderBottomWidth);
      // Lines counted over TEXT nodes only (#858: an element box adds rects).
      const tops = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects())) tops.add(Math.round(r.top));
      }
      out[name] = {
        left: b.left,
        right: b.right,
        height: b.height,
        content,
        fontSize: px(cs.fontSize),
        lines: tops.size,
      };
    }
    return out as Record<keyof typeof parts, Box>;
  }, RAIL_PARTS);

const rail = (page: Page) => page.locator(".shell-members");

async function expectRailGeometry(page: Page, testInfo: TestInfo): Promise<void> {
  const r = rail(page);
  // One WHOIS round trip sits behind bahamut's fake-lag bank (issue 2499's spec).
  const card = r.getByTestId("rail-query-context").getByTestId("whois-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const addDevice = r.getByTestId("e2e-add-device");
  await expect(addDevice).toBeVisible();

  const boxes = await railBoxes(r);
  await testInfo.attach("rail-boxes", {
    body: JSON.stringify(boxes, null, 2),
    contentType: "application/json",
  });

  // 1. The buttons stand alone, one line, and their content box is that
  //    line: at most 1.6 of the font size (the line height of a single
  //    line), where the 44px floor held a 14px line open at three times that.
  for (const button of [boxes.copy, boxes.addDevice]) {
    expect(button.lines).toBe(1);
    expect(button.content).toBeLessThanOrEqual(1.6 * button.fontSize);
  }

  // 2. Every card in the panel on the key sections' edges.
  expect(Math.abs(boxes.own.left - boxes.peer.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.whois.left - boxes.peer.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.whois.right - boxes.peer.right)).toBeLessThanOrEqual(1);
}

test("issue 2506 — the encrypted rail's buttons are sized to their content, and the WHOIS card sits on the key sections' edges", async ({
  page,
}, testInfo) => {
  const peer = await IrcPeer.connect({ nick: `E2506${crypto.randomUUID().slice(0, 8)}` });
  try {
    await boot(page, specUser());
    await equery(page, specNick(), peer.nick);
    await expectRailGeometry(page, testInfo);
  } finally {
    await peer.disconnect("bye").catch(() => {});
  }
});

test("@touch @webkit issue 2506 — on a phone, the drawer's encrypted rail: buttons sized to their content, the WHOIS card on the key sections' edges", async ({
  page,
}, testInfo) => {
  const peer = await IrcPeer.connect({ nick: `E2506${crypto.randomUUID().slice(0, 8)}` });
  try {
    await boot(page, specUser());
    await equery(page, specNick(), peer.nick);
    // The rail's door on a phone is the encrypted pane's top-bar ☰, the one
    // `.topic-bar-hamburger` in this window. Issue 2532: the shared opener,
    // because it returns only once the drawer's slide has ENDED (`.open`
    // lands at its start, and the boxes were measured inside it).
    await openMembersDrawer(page);
    await expectRailGeometry(page, testInfo);
  } finally {
    await peer.disconnect("bye").catch(() => {});
  }
});
