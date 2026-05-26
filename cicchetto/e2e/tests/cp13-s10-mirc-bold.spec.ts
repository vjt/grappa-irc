// CP13 S10 — peer's bold-formatted PRIVMSG renders with mIRC bold span.
//
// Split out from cp13-server-window.spec.ts 2026-05-26 (spec-audit-r5):
// S10 exercises the mIRC formatter (\x02 toggle → run-split → span
// render) which is its own contract — separate failure surface from
// the rest of the CP13 server-window cluster. Isolated file for
// readability + focused triage.
//
// Validates the body-formatter pipeline end-to-end:
//   - peer sends PRIVMSG with embedded \x02 bold toggles
//   - server preserves the wire bytes (no stripping at IRC parser)
//   - cic mIRC parser splits into 3 runs (plain / bold / plain)
//   - bold run renders as `.scrollback-mirc-bold` <span>

import { test, expect } from "../fixtures/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const TEST_CHANNEL = "#bofh";

test("CP13 S10 — peer's bold-formatted PRIVMSG renders with .scrollback-mirc-bold span", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // awaitWsReady=false: the bootstrap-time JOIN line for #bofh has
  // already arrived in the shared grappa session by the time this
  // test runs in full-suite ordering, so the helper's "wait for a
  // fresh JOIN-self line" probe times out. The selectChannel itself
  // still completes — we just don't need the WS-ready handshake.
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

  // Gate the peer.privmsg send on cic having a LIVE per-channel WS
  // subscription, otherwise the server's PubSub broadcast for the
  // boldpeer JOIN+PRIVMSG fires before cic.subscribe.ts joins the
  // `grappa:user:.../channel:#bofh` Phoenix topic — broadcast lands
  // in the void, scrollback row never renders, test times out.
  // members-pane rendering vjt-grappa is the cheapest live-WS
  // signal: it requires the after_join snapshot push of
  // `members_seeded` to have arrived AND been processed, which
  // only happens once the Phoenix channel join completes.
  await expect(page.locator(".members-pane li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });

  // Unique nick per run to dodge a 433 ERR_NICKNAMEINUSE collision
  // when the prior repeat's `boldpeer` ghost is still in bahamut's
  // tables (split-mode leaf doesn't always evict on QUIT). With a
  // static nick the second registration silently rotates to
  // `boldpeer1`, peer.join's matcher waits for `nick === "boldpeer"`
  // forever, and the test times out. Mirror of the cp15-b6-kicked
  // unique-suffix pattern.
  const peer = await IrcPeer.connect({ nick: `boldpeer-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(TEST_CHANNEL);
    // Per-run unique payload so the mIRC-bold count assertion below
    // doesn't trip over an accumulated-state false-positive: the
    // sqlite scrollback persists across specs in a single suite run
    // (tear-down only nukes the testnet container, not the bind-
    // mounted runtime DB), so a static "BOLD" marker would let
    // earlier passes pollute later ones with toHaveCount(1)
    // mismatches. The unique tag also reads better in the failure
    // diff when grep-ing the recorded scrollback.
    const boldTag = `BOLD-${crypto.randomUUID().slice(0, 6)}`;
    // \x02 = bold toggle. The body has "x" plain, "<boldTag>" bold, "y" plain.
    peer.privmsg(TEST_CHANNEL, `x\x02${boldTag}\x02y`);

    // The mIRC parser splits the body into 3 runs; the bold run is a
    // <span class="scrollback-mirc-bold">{boldTag}</span>. Look for that
    // span anywhere in the channel scrollback.
    await expect(
      scrollbackLines(page).locator(".scrollback-mirc-bold", { hasText: boldTag }),
    ).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await peer.disconnect("done");
  }
});
