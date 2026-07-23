// #373 — a query (DM) window must FOLLOW a peer's NICK change. Third of the
// query-window-identity family after #371 (services allowlist) and #372
// (incoming casing fold). DISTINCT: not casing — the peer genuinely RENAMES
// (old ≢ new) and nothing migrated the window old→new, so the window kept
// the stale nick and outbound sends routed to the vanished nick → server
// 401 ERR_NOSUCHNICK ("window looks stuck; messages bounce").
//
// Fixed server-authoritative + cic-cache-mirror:
//   * server: EventRouter observes the peer NICK → renames the QueryWindows
//     row + migrates the DM scrollback (dm_with/channel) old→new →
//     broadcasts query_windows_list (sidebar relabel + routing follow),
//   * cic: on the per-channel nick_change, migrate the LIVE scrollback key
//     + this device's selection so the focused window keeps routing.
//
// This e2e pins the LIVE, end-to-end behaviour the ExUnit/vitest units
// can't: the sidebar row RELABELS, prior history stays under the window,
// and a subsequent send REACHES THE RENAMED PEER (no 401). The peer shares
// a channel with us — the only case IRC delivers a NICK (protocol limit,
// documented as an out-of-scope boundary).
//
// Per `feedback_ux_e2e_mandatory` (a UX-behaviour change ships a Playwright
// e2e) and `feedback_e2e_user_class_parity_matrix` (the surface is
// subject-agnostic, so one user-class spec suffices). No `@webkit` tag →
// desktop/chromium project only, so the `.shell-sidebar` selector applies.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  waitForDmListenerReady,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Real grappa session (not a seed-per-spec DB) — unique suffixes so retries
// / sibling specs don't strict-mode-collide on persisted scrollback or on a
// nick already in use upstream (same rule as nick-case-incoming.spec.ts).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const OLD_NICK = `Guest${RUN_ID}`;
const NEW_NICK = `NickTmp${RUN_ID}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];
const OWN_BODY = `#373 own ${RUN_ID}`;
const REPLY_BODY = `#373 reply ${RUN_ID}`;
const FOLLOWUP_BODY = `#373 followup ${RUN_ID}`;

test("query window follows a peer NICK change — relabels, keeps history, routes with no 401", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: OLD_NICK });
  try {
    // Share a channel so grappa observes the peer's NICK (IRC only relays a
    // NICK to users sharing a channel with the renamer).
    await peer.join(CHANNEL);

    // STEP 1 — open + focus the query window with the OLD nick.
    await composeSend(page, `/q ${OLD_NICK}`);
    const sidebar = page.locator(".shell-sidebar");
    const oldRow = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${OLD_NICK}$`),
    });
    await expect(oldRow).toHaveCount(1, { timeout: 5_000 });

    // STEP 2 — build a two-way conversation so the history-migration is
    // observable: own send (gate on the query-window subscribe) + peer reply
    // (gate on the own-nick DM-listener subscribe).
    await waitForQueryWindowReady(page, NETWORK_SLUG, OLD_NICK);
    await composeSend(page, OWN_BODY);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible({ timeout: 5_000 });

    await waitForDmListenerReady(page, NETWORK_SLUG);
    peer.privmsg(NETWORK_NICK, REPLY_BODY);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toBeVisible({ timeout: 5_000 });

    // STEP 3 — the peer RENAMES.
    await peer.changeNick(NEW_NICK);

    // Sidebar relabels authoritatively (server query_windows_list): the NEW
    // row appears and the OLD row is gone — one window, not a phantom split.
    const newRow = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${NEW_NICK}$`),
    });
    await expect(newRow).toHaveCount(1, { timeout: 5_000 });
    await expect(oldRow).toHaveCount(0);

    // History followed: the pre-rename conversation is still in the (still-
    // focused) window — cic migrated the live scrollback key + selection.
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toBeVisible();

    // STEP 4 — the core fix: a send in the focused window REACHES THE RENAMED
    // PEER. Pre-fix it routed to the vanished old nick → 401 and never
    // arrived. Attach the peer's receive-listener BEFORE the send.
    //
    // Gate on the NEW query topic being subscribed first: after the rename
    // the query-windows loop re-joins `(slug, NEW_NICK)`, and the server
    // fastlanes the own echo ONLY to a subscribed socket (no PubSub replay,
    // #254). Without this gate the own-echo render (line below) races the
    // re-subscribe — the send still ROUTES (asserted via `received`), but
    // its scrollback echo can miss the live push until the next refresh.
    await waitForQueryWindowReady(page, NETWORK_SLUG, NEW_NICK);
    const received = peer.waitForPrivmsg(NETWORK_NICK, FOLLOWUP_BODY);
    await composeSend(page, FOLLOWUP_BODY);
    await received; // times out if grappa still routed to the stale nick
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: FOLLOWUP_BODY }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("#373 done");
  }
});
