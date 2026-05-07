// CP15 B6 — archived query revival.
//
// Asserts the DM (query) lifecycle through the archive:
//   1. `/q <peer>` opens a query window on vjt's sidebar; no
//      scrollback row exists yet, but the window is in
//      queryWindowsByNetwork.
//   2. Vjt sends "hello-archive" → the PRIVMSG persists server-side
//      with dm_with = peer, so the archive query (run later) finds
//      a row keyed on peer's nick.
//   3. Vjt clicks × on the query window → closeQueryWindowState fires
//      → the window leaves queryWindowsByNetwork.
//   4. Expand Archive <details> → loadArchive fetches the per-network
//      list → the peer entry shows up under Archive (kind: "query").
//   5. Click the archived entry → setSelectedChannel(kind: "query")
//      moves focus, but the window is NOT yet revived
//      (openQueryWindowState wasn't called by the archive click —
//      the click is a navigate-to-history affordance, not a revive).
//   6. Vjt types `/msg peer hi-again` in compose → /msg arm calls
//      openQueryWindowState → window re-enters queryWindowsByNetwork
//      AND visibleArchiveForNetwork's render-time filter drops the
//      peer entry from the archive list (active/archive boundary
//      restored). The window appears in the active query section.
//
// Peer setup: a single IrcPeer instance stays connected for the
// duration so vjt's PRIVMSGs land on a real upstream nick that
// bahamut routes back as a notice / privmsg-echo (and the dm_with
// row persists server-side regardless of peer activity — the row
// is created at PRIVMSG send-time on the bouncer's IRC client).
//
// CHANNEL CLEANUP: closeQueryWindowState is the only persistent
// effect; afterEach drops it explicitly so subsequent specs don't
// inherit the window. Peer disconnect cleans the upstream nick.

import { test, expect } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = `cp15b6q-${crypto.randomUUID().slice(0, 6)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("CP15 B6 — /msg peer + close → archive entry; revive via /msg drops the archive entry", async ({
  page,
}) => {
  // Peer must be online so the upstream PRIVMSG target exists
  // (bahamut would emit 401 ERR_NOSUCHNICK otherwise; the bouncer
  // would still persist the outbound row, but the e2e flow stays
  // closer to a normal user interaction with a live target).
  peer = await IrcPeer.connect({ nick: PEER_NICK });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // /msg opens the query window, focuses it, and sends the PRIVMSG
  // in one compose interaction. The PRIVMSG persists with dm_with =
  // peer so the archive query (run later) finds the entry.
  await composeSend(page, `/msg ${PEER_NICK} hello-archive`);
  const queryRow = page.locator(".sidebar-network", {
    has: page.locator("h3", { hasText: NETWORK_SLUG }),
  }).locator("li", { hasText: PEER_NICK });
  await expect(queryRow).toHaveCount(1, { timeout: 5_000 });

  // Confirm the row landed server-side via REST before closing — the
  // close fire-and-forgets a WS push and the archive REST race that
  // ate the prior version of this spec was the underlying cause:
  // closing before the row is durable means active_keyset still
  // includes peer when archive REST fires.
  await expect(
    page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]').filter({
      hasText: "hello-archive",
    }),
  ).toBeVisible({ timeout: 5_000 });

  // Close × — closeQueryWindowState drops the window from
  // queryWindowsByNetwork. The cic-side row vanishes immediately;
  // server-side close_query_window event is fired so a reload would
  // see the same state.
  await queryRow.locator(".sidebar-close").click();
  await expect(queryRow).toHaveCount(0, { timeout: 5_000 });

  // Expand Archive — loadArchive fires on toggle; the per-network
  // archive REST query returns the peer entry (has scrollback row,
  // not in active query set).
  const archiveSection = page.locator(".sidebar-network", {
    has: page.locator("h3", { hasText: NETWORK_SLUG }),
  }).locator("details.sidebar-archive");
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");
  const archivedEntry = archiveSection.locator("button.sidebar-window-btn", {
    hasText: PEER_NICK,
  });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // Click the archive entry — focus moves to the query window for
  // history viewing. NB: this does NOT call openQueryWindowState
  // by design; the click is "view history", not "revive". The
  // window is selected for read-only inspection until the user
  // sends.
  await archivedEntry.click();

  // Revive via /msg — the /msg arm calls openQueryWindowState which
  // adds the entry back to queryWindowsByNetwork. The render-time
  // visibleArchiveForNetwork filter then excludes the peer entry
  // from the archive section on the next reactive flush.
  await composeSend(page, `/msg ${PEER_NICK} hi-again`);

  // Active query row reappears.
  await expect(queryRow).toHaveCount(1, { timeout: 5_000 });

  // Archive entry dedup: must vanish on the same tick the query
  // re-enters queryWindowsByNetwork. This is the live-state filter
  // contract — without it the peer would dup-render (Active +
  // Archive) until next archive REST refetch.
  await expect(
    archiveSection.locator("button.sidebar-window-btn", { hasText: PEER_NICK }),
  ).toHaveCount(0, { timeout: 5_000 });
});
