// #981 — no unread badge on a window whose tail the operator is watching.
//
// The report (vjt, 2026-08-07): a channel is selected, the pane is already at
// the bottom, a message lands — the badge blinks `1` and clears itself. The
// blink is the gap between the badge memo (synchronous, the row is past the
// cursor the instant it lands) and the read-at-the-tail cursor arm (debounced
// `READ_AT_TAIL_SETTLE_MS = 500`). The ruling is the wider one: while you are
// at the bottom of a window, no badge at all.
//
// Why this cannot be a jsdom test: the suppression is gated on the pane's
// GEOMETRY (`atBottomNow`), and jsdom's zero-height boxes read as at-the-tail
// unconditionally — measured under #887, deleting that gate leaves the whole
// ScrollbackPane suite green. jsdom can only pin the pieces either side of the
// geometry; the geometry itself lives here.
//
// ── How this spec avoids being vacuous ──────────────────────────────────────
// It asserts an ABSENCE across a window that is 500 ms wide, so two things
// have to be true or it proves nothing:
//
//   1. The observation must be CONTINUOUS and must OUTLIVE the mechanism it
//      denies. A `toHaveCount(0)` check — even a retrying one — samples, and
//      every sample can legitimately land in a gap: it would pass against the
//      broken build simply by arriving after the arm had cleared the badge.
//      So a MutationObserver is armed BEFORE the message is sent and records
//      every appearance of the badge for the whole run, and the wait after the
//      row lands is longer than the debounce plus browser slop.
//   2. The instrument must be provably able to SEE a badge. An empty
//      recording is only meaningful if a non-empty one was reachable, so the
//      same observer, with the same selector, is then made to record a real
//      badge: switch away from the channel and send again. If that positive
//      control comes back empty the recording apparatus is broken and the
//      negative above is worthless — which is exactly what the assertion says.
//
// Per `feedback_e2e_user_class_parity_matrix`: this pins a rendering CONTRACT,
// not a verb across user classes — one seeded registered user is right.

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "badge981-buddy";
const SERVER_WINDOW = "Server";
const RUN_ID = crypto.randomUUID().slice(0, 8);

// Longer than the pane's read-at-the-tail debounce (500 ms) plus generous
// browser slop. The recording must outlive the blink it denies; a negative
// that expires before the mechanism does proves nothing.
const PAST_READ_AT_TAIL_SETTLE_MS = 1_500;

// The badge for the channel under test, as a plain CSS selector the page can
// evaluate (the Playwright locator is section-scoped and cannot cross into
// `page.evaluate`). Desktop-only class: this spec is untagged, so it runs on
// the chromium project alone.
const BADGE_SELECTOR = `li[data-window-name="${CHANNEL}"] .sidebar-msg-unread`;

type BadgeSighting = { text: string; atMs: number };

declare global {
  interface Window {
    __cic981Sightings?: BadgeSighting[];
  }
}

// Arm a MutationObserver that records every state of the badge, once per DOM
// mutation anywhere in the document. Solid renders the badge by INSERTING the
// element, so an appearance is always a mutation; the observer callback runs
// at the end of the task that inserted it, while the element is still there.
async function armBadgeObserver(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    window.__cic981Sightings = [];
    const sample = (): void => {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.textContent ?? "").trim();
        if (text !== "") window.__cic981Sightings?.push({ text, atMs: Date.now() });
      }
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, BADGE_SELECTOR);
}

async function readSightings(page: Page): Promise<BadgeSighting[]> {
  return await page.evaluate(() => window.__cic981Sightings ?? []);
}

async function clearSightings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__cic981Sightings = [];
  });
}

test.describe("#981 badge on a window read at the tail", () => {
  // Cascade rule: leave #bofh fully read for whatever runs next.
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("never shows, not even for an instant, while the operator watches the tail", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    // Caught up and parked at the tail — the state the report is about.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, {
      timeout: 10_000,
    });

    // Let the activation settle so the pane has MEASURED its distance to the
    // tail (the suppression withholds itself until it has — see
    // `tailGeometryMeasured`). Without this the spec could pass on a pane that
    // never got to answer.
    await page.waitForTimeout(PAST_READ_AT_TAIL_SETTLE_MS);

    await armBadgeObserver(page);

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      const body = `#981 watched arrival ${RUN_ID}`;
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, body);

      // The row really arrived and the pane tail-followed it into view. This
      // is the non-vacuity floor for the negative below: no arrival, nothing
      // to suppress, and the empty recording would mean nothing.
      await expect(page.locator('[data-testid="scrollback-line"]', { hasText: body })).toBeVisible({
        timeout: 10_000,
      });

      // Past the whole debounce window with the observer running: on the
      // pre-#981 build the badge is up for ~500 ms of this wait.
      await page.waitForTimeout(PAST_READ_AT_TAIL_SETTLE_MS);

      const sightings = await readSightings(page);
      expect(
        sightings,
        `badge appeared while the pane sat at the tail: ${JSON.stringify(sightings)}`,
      ).toEqual([]);

      // ── POSITIVE CONTROL, same observer, same selector ──────────────────
      // Switch away and send again. The badge MUST be recorded now; if it is
      // not, the apparatus above was blind and its silence meant nothing.
      await clearSightings(page);
      await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });
      peer.privmsg(CHANNEL, `#981 defocused arrival ${RUN_ID}`);

      await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveText("1", {
        timeout: 10_000,
      });
      const control = await readSightings(page);
      expect(
        control.length,
        "the MutationObserver recorded nothing for a badge Playwright can see — the negative above is not evidence",
      ).toBeGreaterThan(0);
    } finally {
      await peer.disconnect("#981 watched-arrival done");
    }
  });
});
