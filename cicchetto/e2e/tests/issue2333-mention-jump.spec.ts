// issue 2333 — a tap on a "while you were /away" mention lands ON the message,
// in the window the message lives in.
//
// Drives the real server path end to end, like #188: away → a peer mentions
// the operator → unaway → the server's `maybe_broadcast_mentions_bundle`
// pushes `mentions_bundle` → cic focuses the mentions window. No synthetic
// bundle: the two keys this issue added to it (`id`, `dm_with`, protocol 35)
// have to come from the real server or the spec proves nothing about them.
//
// Two cases, each one outcome the operator can SEE:
//
//   1. A DM mention. An inbound DM is stored at `channel = <own nick>`; before
//      `dm_with` the tap opened the operator's SELF window, where that row is
//      not shown. Asserted: the tap lands in the peer's query window, and the
//      mention row is in the viewport.
//
//   2. A channel mention OLDER than the page a cold load fetches. The tap used
//      to switch windows and stop; the message was simply not loaded ("could
//      not find the message"). Asserted: the region around the id is fetched
//      (`?before=<id+1>`, the half of the region that holds the message) and
//      the mention row is in the viewport. `page.reload()`
//      before the unaway is what makes the case real — without it every row
//      the peer sent is already in the live store and no region is needed.
//
// Untagged → chromium (desktop). The jump is layout-independent; the mobile ✕
// half of the issue is covered by the Shell vitest, not here.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  fetchAllMessagesAsc,
  fetchScrollbackPage,
  restoreReadCursorToTail,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const HOME_CHANNEL = AUTOJOIN_CHANNELS[0];

// bahamut's fake-lag: each PRIVMSG banks ~2s of penalty that drains at ~1s,
// and the link dies past ~10s banked (measured in #360). The first
// `FLOOD_SAFE_BURST` lines go out at once, the rest at the drain rate. Split
// across `FILLER_PEERS` connections because the penalty is per connection.
const FLOOD_SAFE_BURST = 3;
const PACE_MS = 2_200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A cold load on a fully-read channel takes the server's default page before
// the cursor (~50 rows, `MessagesController` @default_limit). 60 rows after the mention put it past
// that page with margin — and the spec MEASURES that premise against the
// server before the tap, so a change to the page size fails loudly instead of
// turning this into a vacuous pass.
const FILLER_PEERS = 3;
const FILLER_PER_PEER = 20;

async function unawayIntoMentions(page: Page): Promise<void> {
  // The bundle focuses the mentions window, which unmounts the compose box:
  // `expectUnmount` waits for that instead of an emptied textarea.
  await composeSend(page, "/away", { expectUnmount: true });
  await expect(page.getByTestId("mentions-window")).toBeVisible({ timeout: 10_000 });
}

test.describe("issue 2333 — a mention tap lands on the message", () => {
  test("a DM mention opens the peer's query window with the row in view", async ({ page }) => {
    const vjt = specUser();
    const runId = crypto.randomUUID().slice(0, 8);
    const peerNick = `m2333d-${runId.slice(0, 4)}`;
    const body = `${specNick()} dm ping ${runId}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, HOME_CHANNEL, { ownNick: specNick() });
    await composeSend(page, "/away lunch");

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      peer.privmsg(specNick(), body);
      // Persisted before the unaway, or the aggregation races it.
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: peerNick,
        sender: peerNick,
        body,
        timeoutMs: 10_000,
      });

      await unawayIntoMentions(page);

      // Filed under the PEER, not under our own nick.
      await expect(page.getByTestId("mentions-group-channel")).toHaveText([peerNick]);
      await page.getByTestId("mentions-row").first().click();

      await expect(page.getByTestId("mentions-window")).toHaveCount(0);
      const row = scrollbackLine(page, "privmsg", `dm ping ${runId}`);
      await expect(row).toBeInViewport({ timeout: 10_000 });
      // The window it landed in is the query with the peer: the sidebar row
      // for the peer is the selected one.
      await expect(
        page.locator(
          `.sidebar-network-section[aria-label="${NETWORK_SLUG} windows"] li[data-window-name="${peerNick}"]`,
        ),
      ).toHaveClass(/selected/);
    } finally {
      await peer.disconnect("bye");
    }
  });

  test("a channel mention outside the loaded page is fetched and shown", async ({ page }) => {
    test.setTimeout(180_000);
    const vjt = specUser();
    const runId = crypto.randomUUID().slice(0, 8);
    const channel = `#m2333-${runId.slice(0, 4)}`;
    const mention = `${specNick()} deep ping ${runId}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, HOME_CHANNEL, { ownNick: specNick() });
    await composeSend(page, `/join ${channel}`);
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
    // Back to the home channel: the reload below must not boot INTO the deep
    // channel, or its cold load would be what we then measure.
    await selectChannel(page, NETWORK_SLUG, HOME_CHANNEL, { awaitWsReady: false });
    await composeSend(page, "/away deep");

    const mentioner = await IrcPeer.connect({ nick: `m2333m-${runId.slice(0, 4)}` });
    const fillers: IrcPeer[] = [];
    try {
      await mentioner.join(channel);
      mentioner.privmsg(channel, mention);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel,
        sender: `m2333m-${runId.slice(0, 4)}`,
        body: mention,
        timeoutMs: 10_000,
      });

      for (let p = 0; p < FILLER_PEERS; p++) {
        const f = await IrcPeer.connect({ nick: `m2333f${p}-${runId.slice(0, 4)}` });
        fillers.push(f);
        await f.join(channel);
      }
      await Promise.all(
        fillers.map(async (f, p) => {
          for (let i = 0; i < FILLER_PER_PEER; i++) {
            if (i >= FLOOD_SAFE_BURST) await sleep(PACE_MS);
            f.privmsg(channel, `m2333 filler ${p}-${i} ${runId}`);
          }
        }),
      );
      // Each connection delivers in order, so its LAST line persisted means
      // all of its lines did.
      for (let p = 0; p < FILLER_PEERS; p++) {
        await assertMessagePersisted({
          token: vjt.token,
          networkSlug: NETWORK_SLUG,
          channel,
          sender: `m2333f${p}-${runId.slice(0, 4)}`,
          body: `m2333 filler ${p}-${FILLER_PER_PEER - 1} ${runId}`,
          timeoutMs: 15_000,
        });
      }

      // The read cursor goes to the tail — the operator read this channel
      // elsewhere. Selecting the channel above baselined it at the JOIN row,
      // and a cold load anchored THERE fetches `after(cursor, 200)`, which
      // would carry the mention and make the jump a no-op. At the tail the
      // cold load is the ~50-row page before the cursor.
      await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, channel);

      // Premise, measured rather than assumed: that page does NOT contain the
      // mention.
      const all = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, channel);
      const mentionId = all.find((m) => m.body === mention)?.id;
      expect(mentionId).toBeDefined();
      const tail = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, channel);
      expect(tail.some((m) => m.id === mentionId)).toBe(false);

      // Empty the live store: from here the deep channel's rows exist only on
      // the server, so the mention is reachable only through a region fetch.
      await page.reload();
      await selectChannel(page, NETWORK_SLUG, HOME_CHANNEL, { awaitWsReady: false });

      const regionFetches: string[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (req.method() === "GET" && url.includes(`before=${(mentionId as number) + 1}`)) {
          regionFetches.push(url);
        }
      });

      await unawayIntoMentions(page);
      await page
        .getByTestId("mentions-group")
        .filter({ hasText: channel })
        .getByTestId("mentions-row")
        .first()
        .click();

      await expect(page.getByTestId("mentions-window")).toHaveCount(0);
      const row = scrollbackLine(page, "privmsg", `deep ping ${runId}`);
      await expect(row).toBeInViewport({ timeout: 10_000 });
      // The region path ran — without it the row above could only be in view
      // if the cold load had reached it, and then this spec would prove
      // nothing about the jump.
      expect(regionFetches.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([mentioner, ...fillers].map((p) => p.disconnect("bye").catch(() => {})));
    }
  });
});
