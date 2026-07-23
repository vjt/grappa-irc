// #372 — INCOMING query-window routing folds the sender nick. Sibling of
// `nick-case-sensitivity.spec.ts` (which covers the OUTGOING /q
// direction; there the user re-typed a differently-cased /q).
//
// Bug: the user opens a query window with one casing (`foldreplypeer`);
// the service/peer replies from a differently-cased nick
// (`FoldReplyPeer`). The reply MUST land in the SAME window. Pre-fix cic's
// DM-listener re-keyed the append on the RAW sender casing
// (`installDmListenerHandler` → `channelKey(slug, message.sender)`), so
// the reply fell into a phantom `FoldReplyPeer` bucket the opened window
// never renders ("window looks dead — no replies appear"), and the server
// split it into an archived `FoldReplyPeer` window because the DM read +
// archive paths (`Scrollback.channel_or_dm_where` / `list_archive`)
// matched/grouped the peer RAW instead of folding — while delete already
// folded ("delete either → deletes both"). Fixed on BOTH sides:
//   * server: fold the DM peer on the read + archive paths (rfc1459),
//   * cic: re-key incoming DMs via `canonicalQueryNick` (this spec).
//
// This e2e pins the LIVE routing (the reply appears in the opened window,
// no phantom split); the server ExUnit + cic vitest cover the read-fetch
// and archive fold.
//
// Per `feedback_ux_e2e_mandatory` (a UX-behaviour change ships a
// Playwright e2e — vitest jsdom can't see the WS→scrollback wiring) and
// `feedback_e2e_user_class_parity_matrix` (the surface is subject-agnostic
// case-folding, so one user-class spec suffices). No `@webkit` tag →
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

const PEER_NICK_LOWER = "foldreplypeer";
const PEER_NICK_PROPER = "FoldReplyPeer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Real grappa session (not a seed-per-spec DB) — unique body prefix so
// retries / sibling specs don't strict-mode-collide on persisted
// scrollback (same rule as marker-target-window-regression.spec.ts).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const OWN_BODY = `#372 own ${RUN_ID}`;
const REPLY_BODY = `#372 reply ${RUN_ID}`;

test("incoming reply from a differently-cased nick lands in the opened query window (no split)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Peer registers with the PROPER-case nick — its PRIVMSG source prefix
  // on the wire carries that casing (rfc1459 makes it the SAME nick as
  // the lowercase window the user opens below).
  const peer = await IrcPeer.connect({ nick: PEER_NICK_PROPER });
  try {
    await peer.join(CHANNEL);

    // STEP 1 — open + focus the query window with the LOWERCASE nick.
    await composeSend(page, `/q ${PEER_NICK_LOWER}`);

    const sidebar = page.locator(".shell-sidebar");
    // Case-insensitive match so a phantom proper-case row WOULD be counted.
    const queryRows = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${PEER_NICK_LOWER}$`, "i"),
    });
    await expect(queryRows).toHaveCount(1, { timeout: 5_000 });
    await expect(queryRows.first()).toHaveText(PEER_NICK_LOWER);

    // STEP 2 — own PRIVMSG in the focused DM. Gate on the query-window
    // subscription so the own echo doesn't fastlane past an unsubscribed
    // socket (no self-JOIN line to await for a DM — the #254 seam).
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER_NICK_LOWER);
    await composeSend(page, OWN_BODY);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible({ timeout: 5_000 });

    // STEP 3 — peer replies from the PROPER-case nick. Gate on the
    // DM-listener (own-nick topic) subscription — peer→own DMs fan out
    // there. Pre-fix the reply was re-keyed to a phantom `FoldReplyPeer`
    // bucket and never rendered in the opened window.
    await waitForDmListenerReady(page, NETWORK_SLUG);
    peer.privmsg(NETWORK_NICK, REPLY_BODY);

    // The reply lands in the SAME (focused) window's scrollback...
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toBeVisible({ timeout: 5_000 });
    // ...alongside the own message — one conversation, not split.
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible();

    // STEP 4 — still exactly ONE query row (case-insensitive); no phantom
    // proper-case duplicate row appeared in the sidebar.
    await expect.poll(async () => queryRows.count(), { timeout: 3_000 }).toBe(1);
    expect(await queryRows.count()).toBe(1);
    await expect(queryRows.first()).toHaveText(PEER_NICK_LOWER);
  } finally {
    await peer.disconnect("#372 done");
  }
});
