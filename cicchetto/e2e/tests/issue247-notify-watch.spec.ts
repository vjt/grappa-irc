// #247 — /notify presence watch, end to end (review 2026-07-19 R3).
//
// The unit layers cover the store mechanics (notifyWatch vitest), the
// slash-command parse, and the server context/controller contracts —
// but none of them see the full loop: compose /notify → REST →
// Grappa.Notify → live WATCH + sync on the armed session → bahamut
// 604/605 baseline + 600/601 transitions → typed wire events → watch
// list dots + transition toasts. This spec drives that loop against
// the real testnet (bahamut advertises WATCH=, so the WATCH mechanism
// is the one exercised; MONITOR shares the same session plumbing and
// is pinned at the unit layer in presence_test.exs).
//
// #356 — the watch list MOVED off the home page into the settings
// "watch lists" section (WatchlistsSettings sub-page); /notify is now
// classic-IRC irssi-direct (`/notify <nick>` adds, no `add` subverb).
// The presence loop is unchanged — this spec observes the dots in the
// settings sub-page now, and the transition toasts (bottom-right, panel-
// independent) exactly as before.
//
// Assertions, in order:
//   1. /notify of an offline peer → watch-lists entry with an OFFLINE
//      dot (605 RPL_NOWOFF baseline — dot painted, NO toast: the
//      baseline-vs-transition rule).
//   2. Peer connects → ONLINE transition toast + dot flips (600).
//   3. Reload mid-session → dot repaints ONLINE from the
//      presence_snapshot after-join push (snapshot-on-attach contract)
//      with the peer still connected.
//   4. Peer quits → OFFLINE transition toast + dot flips (601).
//   5. × removes the entry (server round-trip: DELETE → WATCH - sync →
//      notify_list broadcast re-renders the list empty).
//
// Cleanup is REST (DELETE /networks/:slug/notify) in finally so a
// mid-spec failure can't strand the watch entry in vjt's durable list
// for later specs.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { expect, test } from "../fixtures/test";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "i247-watched";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Body is ~6 condition-waits (each fast in isolation) + one reload +
// one peer register; 90s is the standard full-suite-load budget used
// by the sibling session-lifecycle specs.
test.setTimeout(90_000);

test("#247 — /notify → dots + toasts + snapshot repaint + settings remove", async ({ page }) => {
  const vjt = getSeededVjt();
  let peer: IrcPeer | null = null;

  const entryRow = page
    .getByTestId(`watchlists-notify-${NETWORK_SLUG}`)
    .locator(".watchlists-item", { hasText: PEER_NICK });
  const dot = entryRow.locator(".watchlists-dot");

  // #356 — the list lives in the settings "watch lists" sub-page now.
  // Open it (cog → nav row) whenever a dot must be observed; the drawer
  // resets closed across a reload, so this is called again after step 3.
  const openWatchLists = async (): Promise<void> => {
    await page.getByLabel(/open settings/i).click();
    await page.getByTestId("watchlists-settings-entry").click();
    await expect(page.getByTestId("watchlists-subpage")).toBeVisible({ timeout: 10_000 });
  };

  try {
    await loginAs(page, vjt);

    // Compose lives on channel windows — issue the add from the seed
    // channel, then open the settings watch-lists section to observe it.
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
    await composeSend(page, `/notify ${PEER_NICK}`);
    await openWatchLists();

    // 1. Entry present; dot settles OFFLINE via the 605 baseline (the
    //    peer isn't connected yet). Baseline must NOT toast.
    await expect(entryRow).toHaveCount(1, { timeout: 10_000 });
    await expect(dot).toHaveAttribute("data-state", "offline", { timeout: 10_000 });
    await expect(page.locator(".presence-toast")).toHaveCount(0);

    // 2. Peer connects → 600 RPL_LOGON → genuine transition: toast +
    //    dot flip. Arm the toast wait BEFORE connecting so the 6s
    //    self-expiry can't outrace the first poll.
    const onlineToast = page.locator(".presence-toast-online", { hasText: PEER_NICK });
    const onlineToastSeen = expect(onlineToast).toBeVisible({ timeout: 15_000 });
    peer = await IrcPeer.connect({ nick: PEER_NICK });
    await onlineToastSeen;
    await expect(dot).toHaveAttribute("data-state", "online", { timeout: 10_000 });

    // 3. Snapshot-on-attach: reload with the peer still online — the
    //    dot must repaint ONLINE from presence_snapshot alone (no
    //    transition occurs during the reload window). The drawer resets
    //    closed on reload, so reopen the watch-lists section.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
    await openWatchLists();
    await expect(entryRow).toHaveCount(1, { timeout: 10_000 });
    await expect(dot).toHaveAttribute("data-state", "online", { timeout: 10_000 });

    // 4. Peer quits → 601 RPL_LOGOFF → offline transition toast + flip.
    const offlineToast = page.locator(".presence-toast-offline", { hasText: PEER_NICK });
    const offlineToastSeen = expect(offlineToast).toBeVisible({ timeout: 15_000 });
    await peer.disconnect("gone (#247 e2e)");
    peer = null;
    await offlineToastSeen;
    await expect(dot).toHaveAttribute("data-state", "offline", { timeout: 10_000 });

    // 5. Remove from the settings list — server round-trip, list re-renders
    //    from the notify_list broadcast (cic never edits its own store).
    await entryRow
      .getByRole("button", { name: `Stop watching ${PEER_NICK} on ${NETWORK_SLUG}` })
      .click();
    await expect(entryRow).toHaveCount(0, { timeout: 10_000 });
  } finally {
    if (peer !== null) {
      await peer.disconnect("cleanup (#247 e2e)").catch(() => {});
    }
    // Durable-list cleanup: idempotent whether step 5 ran or not.
    await fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/notify`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${vjt.token}` },
    }).catch(() => {});
  }
});
