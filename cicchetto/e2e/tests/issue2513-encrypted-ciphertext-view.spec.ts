// issue 2513 — an encrypted chat shown as what the server and the network
// see: each message as the `E2E` payload it crossed IRC as, in both
// directions, behind the encrypted window's row in the sidebar (its context
// menu: a right-click, a hold on a touch device), never the top bar. Two
// browsers, two grappa users, two real vodozemac engines, one real ircd.
//
// ## What makes this spec able to fail
//
//   * No menu on the row, or no "Show ciphertext" in it.
//   * The view shows anything but the payloads: the plaintext is still on
//     screen, or a line is not `E2E <verb> <msgid> <json>`.
//   * The payloads are not the ones that travelled: Alice's line for what she
//     sent differs from Bob's line for what he read (verb, msgid, payload),
//     and the other way round. grappa mints the msgid as it cuts the payload
//     into IRC lines, and Bob's grappa reads it back off those lines, so two
//     equal lines are one IRC message seen from its two ends.
//   * "Show plaintext" does not bring the messages back.
//
// The desktop arm opens the menu with a right-click. The phone arm (`@touch`)
// opens the window list with the left-edge swipe and the menu with a hold,
// the way iOS has to (it sends no `contextmenu` for a hold); a hold cannot be
// synthesized on Playwright's WebKit (`new Touch` throws there), so the phone
// arm runs on chromium only.

import type { Browser, Page, TestInfo } from "@playwright/test";
import { sidebarWindow } from "../fixtures/cicchettoPage";
import {
  boot,
  chatLines,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { type Pt, synthEdgeGesture } from "../fixtures/shellTouch";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Two logins with their key bundles, two windows, a message each way (the
// first one waits for the peer's keys), and the view flipped twice.
test.setTimeout(180_000);

const HELLO = "2513 ciao bob, questa riga la legge solo chi ha la chiave";
const REPLY = "2513 ciao alice, nemmeno questa la vede il server";

/** One payload, as the view writes it: the verb, the msgid, the compact JSON. */
const FRAME = /^E2E (PKMSG|MSG) [A-Za-z0-9+/]{11} \{\S+\}$/;

/** What each line of the open encrypted window reads, top to bottom. */
const bodies = (page: Page) =>
  chatLines(page).evaluateAll((lines) =>
    lines.map((line) => line.querySelector(".scrollback-body")?.textContent ?? null),
  );

const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: new RegExp(`^${label}$`) });

/** A right-click on the encrypted window's sidebar row, and `label` in its menu. */
async function flip(page: Page, nick: string, label: string): Promise<void> {
  await sidebarWindow(page, NETWORK_SLUG, e2eWindow(nick))
    .locator(".sidebar-window-btn")
    .click({ button: "right" });
  await expect(menuItem(page, label)).toBeVisible();
  await menuItem(page, label).click();
  await expect(page.locator(".context-menu")).toHaveCount(0);
}

type Chat = { peer: Page; aliceNick: string; bobNick: string };

// Alice and Bob in an encrypted query, a message each way, both read.
async function conversation(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
  then: (chat: Chat) => Promise<void>,
): Promise<void> {
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    await send(page, HELLO);
    await expect(row(peer.page, "in", HELLO)).toBeVisible({ timeout: KEYS_TIMEOUT });
    await send(peer.page, REPLY);
    await expect(row(page, "in", REPLY)).toBeVisible({ timeout: KEYS_TIMEOUT });

    await then({ peer: peer.page, aliceNick, bobNick: bob.nick });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
}

test("the sidebar row's menu shows an encrypted chat as the payloads that crossed IRC, the same on both ends, and the plaintext again", async ({
  page,
  browser,
}, testInfo) => {
  await conversation(page, browser, testInfo, async ({ peer, aliceNick, bobNick }) => {
    await flip(page, bobNick, "Show ciphertext");
    await flip(peer, aliceNick, "Show ciphertext");

    const seenByAlice = await bodies(page);
    expect(seenByAlice).toHaveLength(2);
    for (const body of seenByAlice) expect(body).toMatch(FRAME);
    // What Alice sent is what Bob read, and what Bob sent is what Alice read.
    expect(await bodies(peer)).toEqual(seenByAlice);
    for (const p of [page, peer]) {
      const pane = p.getByTestId("e2e-pane");
      await expect(pane).not.toContainText(HELLO);
      await expect(pane).not.toContainText(REPLY);
    }

    await flip(page, bobNick, "Show plaintext");
    await expect(row(page, "out", HELLO)).toBeVisible();
    await expect(row(page, "in", REPLY)).toBeVisible();
    await expect(page.getByTestId("e2e-pane")).not.toContainText("E2E ");
  });
});

// left→center from the screen's edge: the gesture that opens the window list.
const EDGE_SWIPE: Pt[] = [
  { x: 5, y: 400 },
  { x: 70, y: 404 },
  { x: 140, y: 408 },
  { x: 195, y: 410 },
];

const DRAWER = ".shell-mobile .shell-sidebar";

// The window list from the screen's edge, a hold on the encrypted window's
// row in it (a touchstart, a wall-clock hold past LONG_PRESS_MS, a touchend),
// and `label` in the menu that opens; then the list goes, as a tap beside it
// sends it.
async function holdAndFlip(page: Page, nick: string, label: string): Promise<void> {
  await synthEdgeGesture(page, EDGE_SWIPE);
  await expect.poll(async () => (await page.locator(DRAWER).boundingBox())?.x ?? null).toBe(0);
  await page.evaluate(
    async ({ selector, holdMs }) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`no ${selector}`);
      const r = el.getBoundingClientRect();
      const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const fire = (type: "touchstart" | "touchend"): void => {
        const t = new Touch({ identifier: 1, target: el, ...at });
        const active = type === "touchend" ? [] : [t];
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: active,
            targetTouches: active,
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart");
      await new Promise((done) => setTimeout(done, holdMs));
      fire("touchend");
    },
    {
      selector: `${DRAWER} [data-window-name="${e2eWindow(nick)}"] .sidebar-window-btn`,
      holdMs: 700,
    },
  );
  await expect(menuItem(page, label)).toBeVisible();
  await menuItem(page, label).tap();
  await expect(page.locator(".context-menu")).toHaveCount(0);
  await page.locator(".shell-drawer-backdrop.open").tap({ position: { x: 350, y: 400 } });
  await expect(page.locator(DRAWER)).toHaveCount(0);
}

test("@touch on a phone, a hold on the encrypted window's row in the window list shows the ciphertext, and the plaintext again", async ({
  page,
  browser,
}, testInfo) => {
  await conversation(page, browser, testInfo, async ({ bobNick }) => {
    await holdAndFlip(page, bobNick, "Show ciphertext");
    const seen = await bodies(page);
    expect(seen).toHaveLength(2);
    for (const body of seen) expect(body).toMatch(FRAME);
    await expect(page.getByTestId("e2e-pane")).not.toContainText(HELLO);

    await holdAndFlip(page, bobNick, "Show plaintext");
    await expect(row(page, "out", HELLO)).toBeVisible();
    await expect(row(page, "in", REPLY)).toBeVisible();
  });
});
