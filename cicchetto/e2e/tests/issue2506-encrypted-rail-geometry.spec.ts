// issue 2506 — the encrypted query's rail (EncryptedRail under the query
// context, issue 2499), two things vjt saw on his phone:
//   1. its buttons (`pin`, `copy your key`, `add a device`) much taller than
//      one line needs, against the `paste their key` input beside `pin`;
//   2. the peer's WHOIS card under the key sections with a left edge of its
//      own, further in than the peer card and `your identity`.
//
// Asserted as the geometry a person reads, on the desktop rail and in the
// phone drawer:
//   * `pin` is as tall as the input on its row, and no rail button is taller
//     than that input;
//   * the WHOIS card's left and right edges are the key sections' own.
// Every measured box is attached to the run, so a red says by how much.
//
// ## What makes this spec able to fail
//
//   * A rail button grows past the input's height again (a floor, a padding,
//     a label that wraps).
//   * The WHOIS card keeps a horizontal margin the rail's cards do not have.

import type { Locator, Page, TestInfo } from "@playwright/test";
import { boot, equery } from "../fixtures/encryptedQuery";
import { IrcPeer } from "../fixtures/ircClient";
import { expect, specNick, specUser, test } from "../fixtures/test";

type Box = { left: number; right: number; height: number };

// Every box read in ONE frame: the phone drawer slides in, and boxes read one
// call apart would compare edges taken at different points of the slide.
const RAIL_PARTS = {
  peer: '[data-testid="e2e-rail-peer"]',
  own: '[data-testid="e2e-rail-own"]',
  whois: '[data-testid="rail-query-context"] [data-testid="whois-card"]',
  input: '[data-testid="e2e-pin-input"]',
  pin: '[data-testid="e2e-pin-submit"]',
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
      out[name] = { left: b.left, right: b.right, height: b.height };
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

  // 1. `pin` sits on the input's row and takes its height; the other two
  //    stand alone and are no taller than that input.
  expect(Math.abs(boxes.pin.height - boxes.input.height)).toBeLessThanOrEqual(1);
  expect(boxes.copy.height).toBeLessThanOrEqual(boxes.input.height + 1);
  expect(boxes.addDevice.height).toBeLessThanOrEqual(boxes.input.height + 1);

  // 2. Every card in the panel on the key sections' edges.
  expect(Math.abs(boxes.own.left - boxes.peer.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.whois.left - boxes.peer.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.whois.right - boxes.peer.right)).toBeLessThanOrEqual(1);
}

test("issue 2506 — the encrypted rail's buttons are an input tall, and its WHOIS card sits on the key sections' edges", async ({
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

test("@touch @webkit issue 2506 — on a phone, the drawer's encrypted rail: buttons an input tall, the WHOIS card on the key sections' edges", async ({
  page,
}, testInfo) => {
  const peer = await IrcPeer.connect({ nick: `E2506${crypto.randomUUID().slice(0, 8)}` });
  try {
    await boot(page, specUser());
    await equery(page, specNick(), peer.nick);
    // The rail's door on a phone is the encrypted pane's top-bar ☰.
    await page.getByTestId("e2e-pane").locator("header .topic-bar-hamburger").tap();
    await expect(page.locator(".shell-members.open")).toHaveCount(1);
    await expectRailGeometry(page, testInfo);
  } finally {
    await peer.disconnect("bye").catch(() => {});
  }
});
