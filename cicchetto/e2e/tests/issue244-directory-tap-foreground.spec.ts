// #244 (P0) — tapping an UNjoined channel row in the directory (/list →
// DirectoryPane) must JOIN *and* FOREGROUND its window. Amends #125's
// original "join-only, no auto-open" for the USER-INITIATED tap.
//
// The crux (and why jsdom can't cover it — feedback_ux_e2e_mandatory): the
// focus must originate at the tap gesture (DirectoryPane.onJoin, the issuing
// boundary, mirroring compose.ts `/join`) and NOT at the join COMPLETING.
// A completion-driven focus would ALSO fire on an AUTOMATIC re-join
// (reconnect auto-rejoin, cross-device / server-originated join broadcast on
// the user topic) → the #200/#125 focus-steal regression. This spec asserts
// BOTH halves over the real WS + REST + Solid render path:
//
//   1. DESKTOP  — tap an unjoined /list row → that channel's window is the
//      SELECTED window (sidebar tab carries `.selected`).
//   2. DESKTOP negative (no-steal) — while focused on a DIFFERENT window, a
//      server-originated REST join of another channel (which broadcasts
//      window_pending → joined on the user topic, the same path an automatic
//      re-join takes) must NOT move the selection. Proves the WS window-state
//      arms never originate selection; only the tap does.
//   3. MOBILE (@webkit) — same tap-foregrounds behaviour via the BottomBar
//      branch (the onActivate handler is shared, but the selected marker +
//      layout differ; jsdom is blind to both).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts. Hardcoded here
// because the e2e tsconfig does not resolve src/ imports. A rename of the
// constant must be propagated to this file manually.
const LIST_WINDOW_NAME = "$list";

test.describe("#244 directory tap foregrounds the joined window", () => {
  test(
    "DESKTOP — tapping an unjoined /list row joins it AND foregrounds its window",
    async ({ page }) => {
      const vjt = getSeededVjt();
      // Per-run unique channel: a peer creates it (first joiner → +o) and
      // STAYS joined so bahamut includes it in LIST replies (only non-empty
      // channels appear in 322s). vjt never joins it → the /list row is
      // UNJOINED, so a tap exercises the join+foreground path being fixed.
      const channel = `#e2e244-${crypto.randomUUID().slice(0, 8)}`;
      const peer = await IrcPeer.connect({
        nick: `e2e244-${crypto.randomUUID().slice(0, 4)}`,
      });
      try {
        await peer.join(channel);
        await loginAs(page, vjt);

        // Focus a real channel first so the "before" selection is a
        // DIFFERENT window than the one we're about to tap. The foreground
        // assertion is only meaningful as a TRANSITION away from here.
        await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
        await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toHaveClass(
          /selected/,
          { timeout: 10_000 },
        );

        // Open the channel directory for this network.
        await sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME)
          .locator(".sidebar-window-btn")
          .click();
        await expect(page.locator(".directory-search")).toBeVisible({ timeout: 5_000 });

        // Force a fresh LIST so the just-created channel is captured.
        await page.locator(".directory-refresh").click();

        const row = page.locator(".directory-row").filter({
          has: page.locator(".directory-row-name", { hasText: channel }),
        });
        await expect(row).toBeVisible({ timeout: 15_000 });

        // Precondition: the channel is NOT in vjt's sidebar (unjoined).
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(0);

        // TAP the unjoined row → JOIN + FOREGROUND (#244).
        await row.locator(".directory-row-name").click();

        // The channel enters the sidebar …
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(1, {
          timeout: 10_000,
        });
        // … AND becomes the selected window (the P0 fix). Focus originated at
        // the tap, not at the join completing.
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
          timeout: 10_000,
        });
        // The previously-focused window is no longer selected.
        await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).not.toHaveClass(
          /selected/,
        );
      } finally {
        await peer.disconnect("e2e244 desktop done");
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
      }
    },
  );

  test(
    "DESKTOP no-steal — a server-originated (automatic) join does NOT foreground; selection stays put",
    async ({ page }) => {
      const vjt = getSeededVjt();
      // A peer creates + holds a channel so the REST join below succeeds and
      // is a real, non-empty channel. vjt does NOT tap it — the join is
      // issued out-of-band via REST, mimicking an automatic re-join /
      // cross-device join (server broadcasts window_pending → joined on the
      // user topic, the exact path a reconnect auto-rejoin uses).
      const channel = `#e2e244ns-${crypto.randomUUID().slice(0, 8)}`;
      const peer = await IrcPeer.connect({
        nick: `e2e244n-${crypto.randomUUID().slice(0, 4)}`,
      });
      try {
        await peer.join(channel);
        await loginAs(page, vjt);

        // Focus a channel — this is the window that MUST retain focus.
        await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
        await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toHaveClass(
          /selected/,
          { timeout: 10_000 },
        );

        // Out-of-band JOIN via REST (NOT a directory tap). Server flips the
        // window state and broadcasts window_pending → joined on the user
        // topic; cic mirrors state via setPending/setJoined but must NOT
        // originate selection (#200/#125 invariant, preserved by #244).
        await joinChannel(vjt.token, NETWORK_SLUG, channel);

        // The join landed: its tab appears in the sidebar (the broadcast was
        // processed) — so the no-steal assertion below can't pass by the
        // join simply never arriving.
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(1, {
          timeout: 10_000,
        });
        // Give any (buggy) focus-steal a real window to fire before asserting
        // absence, so this can't pass by racing the broadcast.
        await page.waitForTimeout(1_000);

        // Selection STAYED on the original window; the auto-joined channel is
        // NOT foregrounded.
        await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toHaveClass(
          /selected/,
        );
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).not.toHaveClass(/selected/);
      } finally {
        await peer.disconnect("e2e244 no-steal done");
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
      }
    },
  );

  test(
    "MOBILE @webkit — tapping an unjoined /list row foregrounds its window (BottomBar branch)",
    async ({ page }) => {
      const vjt = getSeededVjt();
      const channel = `#e2e244m-${crypto.randomUUID().slice(0, 8)}`;
      const peer = await IrcPeer.connect({
        nick: `e2e244m-${crypto.randomUUID().slice(0, 4)}`,
      });
      try {
        await peer.join(channel);
        await loginAs(page, vjt);

        // On mobile the $list entry lives behind compose `/list` (the
        // DirectoryPane has no BottomBar tab). Focus a channel to get a
        // compose box, then open the directory from it. expectUnmount:
        // selecting the list window unmounts the ComposeBox (Shell renders
        // it only for kindHasScrollback kinds), so wait for the unmount
        // rather than the textarea-empty signal (which races the unmount).
        await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
        await expect(sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toHaveClass(
          /selected/,
          { timeout: 10_000 },
        );
        await composeSend(page, "/list", { expectUnmount: true });
        await expect(page.locator(".directory-search")).toBeVisible({ timeout: 5_000 });

        await page.locator(".directory-refresh").click();
        const row = page.locator(".directory-row").filter({
          has: page.locator(".directory-row-name", { hasText: channel }),
        });
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(0);

        // Tap the unjoined row (touch gesture — iPhone 15 profile has
        // hasTouch). onActivate is shared with desktop; the fix foregrounds.
        await row.locator(".directory-row-name").tap();

        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(1, {
          timeout: 10_000,
        });
        // BottomBar tab for the channel carries `.selected` (sidebarWindow
        // resolves the BottomBar `.bottom-bar-tab` on mobile).
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
          timeout: 10_000,
        });
      } finally {
        await peer.disconnect("e2e244 mobile done");
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
      }
    },
  );
});
