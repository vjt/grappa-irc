// #546 — a NOTICE from a plain peer must NOT open a query window.
//
// Azzurra staff (morph, Sonic, Mezmerize, Hypnotize — #it-opers 2026-07-30)
// asked grappa to follow the irssi/HexChat convention:
//
//   query window already open → the query.  Otherwise → the status window.
//
// Until #546 a peer NOTICE persisted at `channel = sender`, which the
// server-side auto-open (#422) then turned into a sidebar tab — Azzurra's
// welcome notice is sent from a USER, not a service, so every operator got a
// stray tab on connect. This reverses UX-6-L (2026-05-20) / #422 Option B for
// the NOTICE arm only; an inbound PRIVMSG still opens the conversation.
//
// Why e2e and not just ExUnit: the VISIBLE outcome is a sidebar tab that must
// not appear, and its appearance is a three-hop consequence (route → persist →
// `query_windows_list` fan-out → sidebar projection) that jsdom cannot stage.
// Per feedback_ux_e2e_mandatory.
//
// The negative assertion is GATED on a positive barrier: the notice must first
// be observed on `$server`. Without that gate, "no tab appeared" would pass on
// a session that never processed the line at all — a green that proves nothing.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Fresh nick per run/retry: a fixed one is a 433/ghost time bomb under CI
// rerun + bahamut per-IP clone limits (the #600 red), and a leftover
// `query_windows` row from a prior run would pre-open the very window test 1
// asserts is absent — the spec would fail for a reason that is not the code.
const peerNick = (): string => `n546-${crypto.randomUUID().slice(0, 5)}`;

test("#546 — a peer NOTICE with no open query window opens NO tab and lands in $server", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  const nick = peerNick();
  const body = `unsolicited heads up ${nick}`;
  const peer = await IrcPeer.connect({ nick });
  try {
    // Pre-condition: no window for this peer (fresh nick, so this is a
    // statement about the fixture, not about the fix).
    await expect(sidebarWindow(page, NETWORK_SLUG, nick)).toHaveCount(0);

    peer.notice(NETWORK_NICK, body);

    // BARRIER — server-side proof the notice arrived AND where it was routed.
    // Pre-#546 this timed out: the row went to a query window keyed on `nick`.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: "$server",
      sender: nick,
      body,
      kind: "notice",
    });

    // The visible outcome: still no tab for the peer. The barrier above makes
    // this a claim about routing rather than about timing.
    await expect(sidebarWindow(page, NETWORK_SLUG, nick)).toHaveCount(0);

    // ...and the row is readable where it went — the $server window.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
    await expect(scrollbackLine(page, "notice", body)).toBeVisible({ timeout: 10_000 });
  } finally {
    await peer.disconnect("#546 no-tab done");
  }
});

test("#546 — a peer NOTICE lands in the query window when it is already open", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  const nick = peerNick();
  const body = `answering your query ${nick}`;
  const peer = await IrcPeer.connect({ nick });
  try {
    // `/query <nick>` is the sanctioned user-action open: cic pushes
    // `open_query_window`, the server upserts the row and broadcasts the
    // list back. That row IS what `query_window_open?/3` reads.
    await composeSend(page, `/query ${nick}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, nick)).toHaveCount(1, { timeout: 10_000 });

    peer.notice(NETWORK_NICK, body);

    // Server-side: the row is keyed on the PEER, not `$server`.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: nick,
      sender: nick,
      body,
      kind: "notice",
    });

    // Visible: it renders inside that window.
    await selectChannel(page, NETWORK_SLUG, nick, { awaitWsReady: false });
    await expect(scrollbackLine(page, "notice", body)).toBeVisible({ timeout: 10_000 });
  } finally {
    // Bare `/query` closes the focused query window — leave the seeded user's
    // sidebar as we found it (the row is per-user and would otherwise
    // accumulate one dead window per run).
    await composeSend(page, "/query").catch(() => {});
    await peer.disconnect("#546 open-window done");
  }
});
