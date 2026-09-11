// issue 2069 — the sidebar pill and the in-pane divider must answer the same
// question with the same number.
//
// The reported symptom C: "the divider counts presence rows (join/part/quit/
// nick) as unread 'messages'; the sidebar badge does not." Measured at the
// store level on `b7989f4ba` over 150 rows past the cursor (113 peer messages
// + 37 peer JOINs) the pill read 113 and the divider rendered "150 unread
// messages" — a label that says "messages" over a count that is not messages.
//
// This is the browser witness for that, and it is the only place the two
// numbers are ever visible AT ONCE, which is how the operator noticed. The
// vitest arms pin each surface against a fixture; only a rendered page can
// pin that the two AGREE.
//
// RED pre-fix: the peer's JOIN and PART land in the unread run, so the divider
// reads "5 unread messages" against a pill reading "3".
//
// Two premises are asserted rather than assumed, because without either one
// the spec is green on the broken build:
//
//   * the unread run really does contain peer PRESENCE rows (otherwise the two
//     predicates cannot disagree);
//   * those rows are RENDERED (`#spec-wN` is far under
//     `LARGE_CHANNEL_THRESHOLD`, so the #222 filter shows them) — a hidden
//     presence row is excluded from the old count too, by a different rule.
//
// Per BUGHUNT-3 cascade rule the cursor is moved here, so it is restored to
// tail in afterEach or downstream specs inherit a mid-list cursor.

import {
  loginAs,
  selectChannel,
  sidebarEventsBadge,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  restoreReadCursorToTail,
  setShowEventBadge,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "i2069peer";
const PRESENCE_KINDS = new Set(["join", "part", "quit", "nick_change", "mode", "kick"]);

test.afterEach(async () => {
  const vjt = specUser();
  if (!CHANNEL) return;
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test.describe("issue 2069 — one number for one question", () => {
  test("the sidebar pill and the in-pane divider report the same unread count", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Everything before this line is read; everything after it is the unread
    // run under test. Planted BEFORE the peer acts so the run is exactly what
    // this spec produces.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
    const before = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    const cursorId = before[before.length - 1]?.id;
    if (cursorId === undefined) throw new Error("issue 2069 spec: seeded channel is empty");

    // A peer arrives, says three things, and leaves. JOIN and PART persist as
    // presence rows INSIDE the unread run — which is the whole fixture.
    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, "issue 2069 one");
      peer.privmsg(CHANNEL, "issue 2069 two");
      peer.privmsg(CHANNEL, "issue 2069 three");

      // 🔴 This barrier is placed BEFORE the PART on purpose, and it is not
      // politeness — it is what makes the setup deterministic.
      //
      // MEASURED, on this tree, `--repeat-each 20`:
      //
      //   * without this barrier, 9 reds in 20, every one of them the identical
      //     `IrcPeer: timeout waiting for part #spec-w0 (5000ms)` — the same
      //     signature CI turned on shard 2/4 of run 34553963487;
      //   * the cost depends on the command's POSITION in the burst, not on the
      //     clock: `IrcPeer.join` carries the SAME 5s budget (`JOIN_TIMEOUT_MS`
      //     == `PART_TIMEOUT_MS`) and timed out ZERO times across those 20 runs.
      //     First command always fine; fifth command — after JOIN + 3×PRIVMSG —
      //     half the time not;
      //   * with the barrier, 20 green in 20.
      //
      // INFERRED, and labelled as such: that the per-command cost IS bahamut's
      // fake-lag bank. That name is READ, from the `whoisAway` comment in
      // `fixtures/ircClient.ts` and from the ircd source — and reading a
      // mechanism tells you a path EXISTS, never what it costs. This spec has
      // not measured the bank: the instrument that can (`Grappa.IRC.FakeLag`,
      // #800/S7) accounts GRAPPA's own socket, and the peer here is a separate
      // irc-framework connection it never sees. Anything that serialises per
      // connection would fit the same three measurements.
      //
      // The cure does not depend on the name. It rests on the measured half —
      // position in the burst — so draining on an OBSERVABLE signal (the three
      // messages being on the server, the very endpoint polled below) leaves
      // the PART as a lone command. No timeout is raised and no assertion is
      // touched.
      let after = before;
      const peerNick = PEER_NICK.toLowerCase();
      await expect
        .poll(
          async () => {
            after = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
            return after.filter(
              (r) => r.id > cursorId && r.kind === "privmsg" && r.sender.toLowerCase() === peerNick,
            ).length;
          },
          { timeout: 15_000 },
        )
        .toBe(3);

      await peer.part(CHANNEL, "issue 2069 done");

      // Barrier on the SERVER's own store, not a timeout: the PART is the last
      // row the peer produces, so its arrival proves the three messages and the
      // JOIN are already persisted (one ordered IRC stream, one session).
      await expect
        .poll(
          async () => {
            after = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
            return after.filter((r) => r.id > cursorId && r.kind === "part").length;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);

      const unreadRun = after.filter((r) => r.id > cursorId);
      const ownNick = specNick().toLowerCase();
      const messages = unreadRun.filter(
        (r) => !PRESENCE_KINDS.has(r.kind) && r.sender.toLowerCase() !== ownNick,
      );
      const presence = unreadRun.filter(
        (r) => PRESENCE_KINDS.has(r.kind) && r.sender.toLowerCase() !== ownNick,
      );

      // PREMISE 1 — the two predicates can actually disagree here.
      expect(messages).toHaveLength(3);
      expect(presence.length).toBeGreaterThanOrEqual(2);

      // The events pill is behind the #2037 B opt-in; turn it on so the
      // presence rows are visible as a NUMBER too, and the spec can say where
      // they went rather than only that they left the message count.
      await setShowEventBadge(vjt.token, true);

      await loginAs(page, vjt);

      // The sidebar, with the window still UNSELECTED — the pill's own answer,
      // before any reading can move the cursor.
      const pill = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
      await expect(pill).toHaveText(String(messages.length), { timeout: 15_000 });
      await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toHaveText(
        String(presence.length),
      );

      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

      // PREMISE 2 — the presence rows RENDER. If the #222 filter hid them, the
      // old count would have excluded them for an unrelated reason and this
      // spec would pass on the broken build.
      const firstPresence = presence[0];
      if (!firstPresence) throw new Error("issue 2069 spec: no peer presence row in the run");
      await expect(
        page.locator(`[data-testid="scrollback-line"][data-msg-id="${firstPresence.id}"]`),
      ).toBeVisible({ timeout: 15_000 });

      // THE CLAIM — the divider is the MESSAGES count, in the unit its own
      // label announces, and it is the number the sidebar showed.
      await expect(page.locator(".scrollback-unread-marker-label")).toHaveText(
        `${messages.length} unread messages`,
      );
    } finally {
      await peer.disconnect("issue 2069 teardown").catch(() => {});
    }
  });
});
