// #267 — the per-channel MENTION count is SERVER-AUTHORITATIVE.
//
// The pre-#267 count was a client-side regex bump: cic incremented a
// per-channel counter on every inbound PRIVMSG whose body word-boundary-
// matched the operator's own nick. That count was derived purely from
// what ONE connected tab observed live, so it:
//   * NEVER rebuilt on reconnect — a mention that landed while the tab
//     was disconnected/suspended was silently lost forever, and
//   * diverged across tabs/devices — each tab computed its own count
//     from its own event stream.
//
// The fix (server `Grappa.WindowCounts.snapshot/6`, SSOT
// `Mentions.mentioned?/3`) makes the count a pure function of
// `(read_cursor, messages)`: it reconstructs identically on every
// (re)subscribe (seeded by the per-channel join reply's `window_counts`)
// and is pushed live to every subscribed tab on each new message +
// cursor advance (the `window_counts` event → `mentions.setServerMention`).
//
// These two specs exercise the USER-VISIBLE contract that the unit tests
// (`mentions.test.ts`, `subscribe.test.ts`) cannot: a real testnet, a
// real peer, a real WebSocket drop, and a real second browser context.
//
//   1. Reconnect: a mention lands while cic's WS is provably down — a
//      client bump is IMPOSSIBLE (cic never receives the PRIVMSG live) —
//      yet the red badge shows the server count on reconnect.
//   2. Cross-tab: a mention on an unfocused channel fans out from the
//      server to BOTH tabs' badges (one shared truth, not two
//      independently-computed counts).

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarMentionBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "Server";

// A mention is a content row whose body matches the operator's own nick
// (`NETWORK_NICK`). The server's `Mentions.mentioned?/3` word-boundary,
// case-insensitive predicate is the SSOT; we prefix the nick so the body
// unambiguously mentions vjt regardless of the run-unique suffix.
const mentionBody = (runId: string) => `${NETWORK_NICK}: server-authoritative mention ${runId}`;

// Sync gate: after focusing a joined channel, the members pane must list
// the operator's own nick. A rendered member list is the deterministic
// "the JOIN completed + members were seeded" signal — asserting on it
// before defocusing prevents the peer's PRIVMSG from racing an
// incomplete channel subscribe.
async function assertJoinedWithOwnMember(page: Parameters<typeof loginAs>[0]): Promise<void> {
  const membersPane = page.locator(".shell-members .members-pane");
  await expect(membersPane).toBeVisible({ timeout: 10_000 });
  await expect(membersPane.locator(".member-name", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });
}

test("#267 — mention landing during a WS gap surfaces from the server count on reconnect (never a client bump)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const runId = crypto.randomUUID().slice(0, 8);
  const body = mentionBody(runId);

  // Clean baseline: pin the read cursor to the current tail so any
  // pre-existing unread mention on #bofh drops below the cursor and the
  // window's mention count starts at 0. The one mention we send below is
  // then the ONLY row after the cursor → the count is deterministically 1.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  await loginAs(page, vjt);

  // Focus #bofh so its per-channel topic is subscribed (joinChannel fired
  // + JOIN echoed). Gate on the seeded member list before moving on.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await assertJoinedWithOwnMember(page);

  // Defocus to the Server window. The mention badge's focus-zero overlay
  // renders 0 for the selected+visible window; #bofh must be UNFOCUSED
  // for its badge to surface. Server has no compose/JOIN so it can't
  // produce chatter that races the assertion.
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: `i267r-${runId}` });
  try {
    await peer.join(CHANNEL);

    // Drop + HOLD cic's socket. `__cic_dropSocketForTests` issues an
    // explicit phoenix `disconnect()` (no auto-reconnect) so the socket
    // stays down until the resume below — the WS gap is deterministic,
    // and a client regex bump is impossible because cic receives NOTHING
    // live for the duration.
    await page.evaluate(async () => {
      if (!window.__cic_dropSocketForTests) {
        throw new Error("__cic_dropSocketForTests hook missing");
      }
      await window.__cic_dropSocketForTests();
    });
    await page.waitForFunction(() => window.__cic_socketHealth?.state().state !== "open");

    // Peer sends the mention while cic is CONFIRMED disconnected. The
    // server persists it (Session.Server persist is synchronous) and
    // counts it as a mention (id > cursor, body matches own nick); the
    // live `window_counts` push has no subscriber and is dropped.
    peer.privmsg(CHANNEL, body);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: `i267r-${runId}`,
      body,
    });

    // Resume the socket. phoenix auto-rejoins #bofh; the join reply
    // carries `window_counts.mentions: 1`, which `applyJoinReplyAndSeed`
    // feeds into `mentions.setServerMention` → the red badge shows "@1".
    // This is the load-bearing proof: cic NEVER saw the PRIVMSG, so the
    // badge can ONLY come from the server-authoritative snapshot.
    await page.evaluate(async () => {
      if (!window.__cic_resumeSocketForTests) {
        throw new Error("__cic_resumeSocketForTests hook missing");
      }
      await window.__cic_resumeSocketForTests();
    });

    // Generous timeout: phoenix.js rejoin backoff can take a few seconds
    // under suite load before the join reply lands.
    await expect(sidebarMentionBadge(page, NETWORK_SLUG, CHANNEL)).toHaveText("@1", {
      timeout: 30_000,
    });
  } finally {
    await peer.disconnect("i267 reconnect done");
  }
});

test("#267 — mention on an unfocused channel fans out from the server to both tabs' badges", async ({
  browser,
}) => {
  const vjt = getSeededVjt();
  const runId = crypto.randomUUID().slice(0, 8);
  const body = mentionBody(runId);

  // Clean baseline as above — the mention below is the only post-cursor
  // row, so both tabs must converge on exactly "@1".
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  // Two independent browser contexts = two devices/tabs of the SAME
  // operator. Both subscribe to #bofh (autojoin), both defocus to Server
  // so #bofh's badge is not focus-zero-overlaid in either.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    await loginAs(pageA, vjt);
    await loginAs(pageB, vjt);

    await selectChannel(pageA, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await assertJoinedWithOwnMember(pageA);
    await selectChannel(pageB, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await assertJoinedWithOwnMember(pageB);

    await selectChannel(pageA, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });
    await selectChannel(pageB, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

    const peer = await IrcPeer.connect({ nick: `i267x-${runId}` });
    try {
      await peer.join(CHANNEL);

      // ONE mention. The server pushes `window_counts` on the #bofh topic
      // to EVERY subscribed socket → both tabs' `setServerMention` fires.
      // A pre-#267 per-tab client bump would compute its count in
      // isolation; here both render the same server-sourced "@1".
      peer.privmsg(CHANNEL, body);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: CHANNEL,
        sender: `i267x-${runId}`,
        body,
      });

      await expect(sidebarMentionBadge(pageA, NETWORK_SLUG, CHANNEL)).toHaveText("@1", {
        timeout: 15_000,
      });
      await expect(sidebarMentionBadge(pageB, NETWORK_SLUG, CHANNEL)).toHaveText("@1", {
        timeout: 15_000,
      });
    } finally {
      await peer.disconnect("i267 cross-tab done");
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

declare global {
  interface Window {
    __cic_dropSocketForTests?: () => Promise<void>;
    __cic_resumeSocketForTests?: () => Promise<void>;
    __cic_socketHealth?: {
      state: () => { state: string };
    };
  }
}
