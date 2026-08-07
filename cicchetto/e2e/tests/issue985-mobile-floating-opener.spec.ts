// @webkit — #985. On a mobile QUERY window the ☰ must float over the pane's
// top-right corner instead of sitting in a band that costs the conversation a
// row.
//
// The defect vjt reported from the iPhone PWA: every non-channel window
// rendered a full-width `.shell-chrome` header whose only content was the ☰,
// priced at `var(--chrome-tap-min) + 1rem + 1px` and SCALING with the text
// size. The mobile-CHANNEL branch had already reclaimed those pixels (its ☰
// rides inline in the TopicBar); the query case never got a host.
//
// Why an e2e and not a vitest: the defect IS rendered geometry. jsdom has no
// layout engine, so `.shell-chrome`'s source declarations are all a unit test
// can see — pinned in `src/__tests__/shellChromeFloat.test.ts`. What only a
// real engine can answer is whether the scrollback actually starts at the top
// of the pane, whether the floated glyph is actually the element under the
// finger, and whether it is actually opaque over the content behind it.
//
// Mobile-only shape (`ShellChrome` mounts only in Shell's `isMobile()` branch),
// so this runs on webkit-iphone-15 alone — the @webkit tag; the chromium
// project grepInverts it.
//
// NOT covered here, and not coverable here: the notch. Playwright does not
// synthesize `env(safe-area-inset-*)` — they resolve to 0 in both projects — so
// the "clears the Dynamic Island" half of the fix is argued from
// `.shell-mobile`'s existing `padding-top: env(safe-area-inset-top)` (UX-3 BIS)
// and needs a real notched device to be felt. Same standing limitation as
// `railMenuSafeArea.test.ts`.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: this is a UI shape
// contract, subject-shape-agnostic. The registered seed suffices.

import {
  composeSend,
  loginAs,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Per-run-unique: a literal nick collides with itself upstream on rapid reruns
// (--repeat-each), the same rule every peer-driven spec here follows.
const PEER = `F985${crypto.randomUUID().slice(0, 8)}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

test("@webkit #985 — a mobile query window spends no band on the ☰, and the float stays legible and reachable", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER });
  try {
    // Share a channel so the peer is addressable, then open + focus the query.
    await peer.join(CHANNEL);
    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);

    // PRECONDITION — we really are on the non-channel branch. Without this the
    // whole test could pass on a CHANNEL window, where the band was already
    // absent and every assertion below is green for the wrong reason.
    await expect(page.locator(".topic-bar")).toHaveCount(0);
    const chrome = page.getByTestId("shell-chrome");
    const opener = page.getByTestId("shell-chrome-rail-opener");
    // The host is MOUNTED, not VISIBLE — and this spec is the reason. #985
    // collapses `.shell-chrome` to `height: 0` and lets its one child overflow,
    // so the element Playwright is asked about has an empty bounding box and is
    // `hidden` by definition. Asserting it visible here contradicted this same
    // test's own outcome assertion ("the chrome row must cost zero height")
    // twenty lines down: both could never hold at once. What the precondition
    // actually needs to establish is that the non-channel branch mounted its
    // door — so: the host exists, and the door itself is on screen.
    await expect(chrome).toHaveCount(1);
    await expect(opener).toBeVisible({ timeout: 10_000 });

    const main = page.locator(".shell-main");
    const pane = page.locator(".scrollback-pane");
    await expect(pane).toBeVisible();

    const mainBox = await main.boundingBox();
    const paneBox = await pane.boundingBox();
    const openerBox = await opener.boundingBox();
    if (!mainBox || !paneBox || !openerBox) {
      throw new Error("#985 — a measured element has no bounding box");
    }
    // Read through the DOM, not through `boundingBox()`: the latter is defined
    // to return null for an element Playwright considers invisible, and a
    // zero-height box is exactly that — so the very property under test here
    // would have come back as "no bounding box" and thrown above.
    const chromeHeight = await chrome.evaluate((el) => el.getBoundingClientRect().height);

    // THE OUTCOME. The conversation starts at the top of the pane. This is the
    // pixel vjt asked for back, and it is the one number that was wrong before:
    // the pane used to begin a whole band below `.shell-main`'s top edge.
    expect(
      paneBox.y - mainBox.y,
      `#985 — scrollback must start at the pane top; it starts ${paneBox.y - mainBox.y}px below it`,
    ).toBeLessThanOrEqual(1);
    // The mechanism, measured rather than read: the row still exists (the
    // window needs its door) and costs nothing.
    expect(chromeHeight, "#985 — the chrome row must cost zero height").toBeLessThanOrEqual(1);

    // The float must not have shrunk the affordance on its way out of the
    // flow: still the 48px HIG floor `--chrome-tap-min` guarantees.
    expect(Math.round(openerBox.height)).toBeGreaterThanOrEqual(48);
    expect(Math.round(openerBox.width)).toBeGreaterThanOrEqual(48);

    // …and it floats INSIDE the pane's top-right corner rather than escaping
    // it. `.shell-mobile` owns the safe-area inset, so "inside the pane" is
    // also what keeps the glyph clear of the island on a real device.
    expect(openerBox.y).toBeGreaterThanOrEqual(mainBox.y - 0.5);
    expect(openerBox.x + openerBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 0.5);
    expect(openerBox.y).toBeLessThan(mainBox.y + mainBox.height / 2);

    // LEGIBILITY (issue constraint 1). Floating puts the glyph over arbitrary
    // scrollback text and over a themed background image, so a transparent
    // button — which is what `.shell-chrome-btn` declares — would leave it
    // unreadable. Assert a FULLY opaque backing, not merely a non-empty one.
    const bg = await opener.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, "#985 — the floated opener must carry its own backing").not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    // Alpha lives ONLY in the four-component form. CSSOM serialises an opaque
    // colour as `rgb(r, g, b)` whatever the theme (`#fff` in light, `#0a0a0a`
    // in dark), so it is the component COUNT that carries opacity and the
    // check is theme-independent — it never names a colour. Count the
    // channels; do NOT scrape with an optional lazy capture, which is what the
    // first version of this line did: `[^)]*?` stopped early and handed the
    // BLUE channel of `rgb(255, 255, 255)` to the alpha group, failing a
    // perfectly opaque backing. An unrecognised serialisation throws rather
    // than passing — the old `alpha === undefined` arm silently accepted
    // anything that wasn't `rgb()`/`rgba()`.
    const channels = /^rgba?\(([^)]*)\)$/.exec(bg)?.[1].split(",");
    if (!channels || (channels.length !== 3 && channels.length !== 4)) {
      throw new Error(`#985 — unparseable computed backgroundColor: ${bg}`);
    }
    const alpha = channels.length === 4 ? Number(channels[3]) : 1;
    expect(
      alpha,
      `#985 — the floated opener's backing must be fully opaque; computed ${bg}`,
    ).toBe(1);

    // REACHABILITY (issue constraint 2, and the reason the rule carries a
    // z-index at all). The opener overflows a zero-height box, so the
    // later-in-DOM scrollback would paint over it without one. Hit-test the
    // centre of the glyph: the element under the finger must BE the opener,
    // not a scrollback line that happens to sit beneath it.
    const hit = await opener.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit, "#985 — the scrollback must not paint over the floated opener").toBe(true);

    // ONE DRAWER, ONE ☰ (the Opt-A ruling). The float must still be the same
    // door, driving the same `toggleMembersPanel` mutex — a second affordance
    // opening a second state is the bug this must not become.
    await opener.tap();
    await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("i985 cleanup").catch(() => {});
  }
});
