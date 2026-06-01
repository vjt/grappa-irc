// Scroll contamination across windows — N-roundtrip switch sentinel.
//
// vjt prod report (2026-06-01): "I am STILL seeing scroll contamination
// across windows, especially after few back and forths of focusing many
// windows".
//
// Root cause: ScrollbackPane's `[data-testid="scrollback"]` <div> is a
// SHARED DOM node across selectedChannel changes (Shell.tsx wraps all
// of channel|query|server in a SINGLE Match so the pane stays mounted
// across kind transitions — required for the BUGHUNT-2 leave-arm cursor
// write at ScrollbackPane.tsx:1142). `scrollTop` on the DOM node
// survives the swap. The `atBottom` signal does NOT reset on key change,
// so a scrolled-up source window leaks `atBottom=false` into the
// destination pane. When the destination is cold (empty messages()),
// `scrollToActivation`'s rAF×2 body early-returns at ScrollbackPane.tsx
// :1089 WITHOUT resetting scroll OR `atBottom`. REST lands later, the
// length-effect at :1292 reads `atBottom=false` and skips the auto-snap
// — the DOM stays at whatever scrollTop the browser preserved through
// the swap. Visible to vjt as "wrong scroll position in destination
// window after N back-and-forths".
//
// Single-roundtrip coverage exists (scroll-on-window-switch.spec.ts +
// marker-target-window-regression.spec.ts) but neither exercises N
// round-trips with a scrolled-up source. This spec is the only line
// of defense against the contamination class.
//
// Fix: on every key change in the `on(key)` effect (ScrollbackPane.tsx
// :1138), `setAtBottom(true)` unconditionally — every window activation
// re-arms auto-follow. The leaving pane's user-scrolled-up state is
// per-window and MUST NOT leak through the shared DOM node.

import { type Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { expect, test } from "../fixtures/test";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const REST_PAGE_SIZE = 50;
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// A peer that has no DM history — `/query <peer>` opens an empty
// destination window. Empty scrollback → "no messages yet" fallback →
// scrollTop=0 is the clean state. Synthetic suffix avoids collision
// with any seeded peer.
const EMPTY_QUERY_PEER = "no-dm-peer-roundtrip";

async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

// Programmatically scroll the scrollback to the given scrollTop and
// dispatch the synthetic scroll event so the Solid handler updates
// `atBottom`. Same shape cp14-b2 uses.
async function scrollScrollbackTo(page: Page, scrollTop: number): Promise<void> {
  await page.evaluate((t) => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    el.scrollTop = t;
    el.dispatchEvent(new Event("scroll"));
  }, scrollTop);
}

// Reset the cursor to tail so the marker doesn't appear mid-loop and
// poison the "land at bottom" contract. Same guard the
// marker-target-window-regression spec uses.
test.beforeEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("scroll-multi-roundtrip — N back-and-forths preserve destination scroll", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("channel→empty-query→channel-back repeated 5× lands at bottom every return", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Step 1 — focus the seeded channel and confirm overflow.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const g0 = await scrollbackGeometry(page);
    expect(g0.scrollHeight).toBeGreaterThan(g0.clientHeight);

    // Step 2 — open an empty query so the destination is cold (no
    // pre-loaded scrollback). compose.ts dispatches openQueryWindowState
    // + setSelectedChannel; pane re-renders with kind:"query", empty
    // messages, "no messages yet" fallback.
    await composeSend(page, `/query ${EMPTY_QUERY_PEER}`);
    await expect(page.locator(".scrollback-empty")).toBeVisible({ timeout: 5_000 });

    // Switch back so we're on the channel before the loop starts.
    await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Loop: scroll-up in #bofh (operator reading history), bounce to
    // the empty query, return. Pre-fix `atBottom` stays false (the
    // scroll-up set it) and leaks into the empty query's pane mount,
    // then back into #bofh — the destination length-effect skips the
    // auto-snap because `atBottom()` is stale-false. By round 2-3 the
    // scrollTop is visibly wrong.
    //
    // Post-fix the key-effect resets `atBottom = true` unconditionally
    // on every transition, so each return lands at-bottom regardless
    // of how the operator scrolled the source.
    for (let i = 0; i < 5; i++) {
      // Operator scrolls up to mid-history in #bofh.
      await scrollScrollbackTo(page, 100);
      // Bounce: query → channel.
      await sidebarWindow(page, NETWORK_SLUG, EMPTY_QUERY_PEER)
        .locator(".sidebar-window-btn")
        .click();
      await expect(page.locator(".scrollback-empty")).toBeVisible({ timeout: 5_000 });
      await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();
      await expect
        .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

      // Contract: every return to #bofh lands at the bottom (no marker
      // in this scenario — cursor pre-set to tail in beforeEach). Polled
      // because scrollIntoView lands asynchronously vs the layout commit.
      await expect
        .poll(
          async () => {
            const cur = await scrollbackGeometry(page);
            return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
          },
          { timeout: 5_000 },
        )
        .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    }
  });
});
</content>
</invoke>