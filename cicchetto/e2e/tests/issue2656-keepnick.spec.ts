// issue 2656 — keepnick: while the switch is on, a session that registered
// on a fallback nick keeps asking for the configured one, and it does not
// show the operator a refusal for every try.
//
// The Elixir suite (`Grappa.Session.ServerTest`, "issue 2656 — keepnick …")
// proves the whole terminality table against a fake ircd. These three specs
// prove what it cannot: that the switch is wired from the REST door to a
// real session on the real bahamut, and that what bahamut actually sends is
// what the table expects.
//
// ## Staging (the #1152 squat)
//
// The subject is parked, a squatter takes the subject's nick, and the
// subject reconnects. #676's ladder re-registers it as `<name>_`, so every
// spec starts drifted and with the configured nick HELD. The credential has
// no NickServ secret (the spec subject is `auth_method: :none`), so
// GhostRecovery never arms. Option A makes the specs valid anyway, but this
// keeps each one about a single machine.
//
// ## Timing, and why it is not a flake budget
//
// The cadence is the production one: the first try is 12 s after the
// welcome (#2253's `@nick_reclaim_ms`), then one every 30 s while keepnick
// is on. A live toggle tries at once. Nothing below is shortened by a test
// seam, so the specs wait in real time. The waits are measured against
// those constants, not tuned until green.
//
// ## Why E1 is not the design's E1
//
// The design's E1 ("the squatter leaves before the first tick, cic shows
// N") is green with the switch OFF: #2253's one-shot takes a free nick at
// 12 s on its own, so that spec cannot tell keepnick from its absence. E1
// here runs the switch-off world on purpose, and that makes it the positive
// control E2 needs. The one-shot's 433 does land in `$server` when the
// switch is off, so E2's "no 433 row" is a suppression, not a channel that
// never carries the row. After that, E1 turns the switch on LIVE and the
// nick comes back, which proves the toggle reaches a running session.

import {
  fetchAllMessagesAsc,
  joinChannel,
  patchNetworkConnectionState,
  setKeepNick,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, readSpecLiveNick, specUser, test } from "../fixtures/test";

// No switch-off in the `finally` blocks: the subject is provisioned per test
// and deleted with its credential at teardown (`fixtures/test.ts`), and a
// cleanup PATCH that failed would replace the real failure with its own.

const SERVER_WINDOW = "$server";

// #2253's first try is at 001 + 12 s; keepnick's re-arm is 30 s. These are
// the production constants (`Session.Server` `@nick_reclaim_ms`,
// `@keep_nick_interval_ms`), copied as the numbers a timeout has to cover.
const FIRST_TRY_MS = 12_000;
const KEEPNICK_INTERVAL_MS = 30_000;
const SLACK_MS = 8_000;

type Row = Awaited<ReturnType<typeof fetchAllMessagesAsc>>[number];

const numeric = (row: Row): unknown => row.meta?.numeric;
const keepNickStop = (row: Row): unknown => row.meta?.keep_nick;

async function serverRowsSince(token: string, since: number): Promise<Row[]> {
  const rows = await fetchAllMessagesAsc(token, NETWORK_SLUG, SERVER_WINDOW);
  return rows.filter((r) => r.server_time >= since);
}

async function liveNick(): Promise<string | null> {
  const reading = await readSpecLiveNick();
  return reading.kind === "live" ? reading.nick : null;
}

// Reconnects the parked subject while `squatter` holds its nick, and
// returns once the session has registered on a fallback. The barrier is the
// autojoin JOIN, which follows registration in either world (#1152: the
// `connection_state` flips to "connected" before the 433 ladder has
// finished, so polling it reads the nick too early). The JOIN row's
// `server_time` is returned as the cut for every `$server` count below: the
// REGISTRATION 433 that sent the ladder to `<name>_` lands in `$server` too,
// strictly before the welcome, and it is not a keepnick try.
async function registerDrifted(token: string, requested: string): Promise<number> {
  const t0 = Date.now();
  await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "connected" });
  let registeredAt = 0;
  await expect
    .poll(
      async () => {
        const rows = await fetchAllMessagesAsc(token, NETWORK_SLUG, AUTOJOIN_CHANNELS[0]);
        registeredAt = rows.find((r) => r.kind === "join" && r.server_time >= t0)?.server_time ?? 0;
        return registeredAt > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(await liveNick(), "the squat did not move the session off its nick").not.toBe(requested);
  return registeredAt;
}

test.describe("issue 2656 — keepnick", () => {
  test.setTimeout(150_000);

  test("E1. switch off, the one try's refusal shows; switch on live, the nick comes back", async () => {
    const requested = specUser().name;
    const token = specUser().token;

    await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "parked" });
    const squatter = await IrcPeer.connect({ nick: requested });
    try {
      const t0 = await registerDrifted(token, requested);

      // POSITIVE CONTROL for E2. Switch off: #2253 asks once at 12 s, the
      // squatter answers with 433, and the refusal lands in `$server`.
      await expect
        .poll(
          async () => (await serverRowsSince(token, t0)).filter((r) => numeric(r) === 433).length,
          {
            timeout: FIRST_TRY_MS + SLACK_MS,
          },
        )
        .toBe(1);

      // The one-shot is spent: freeing the nick now brings nothing back by
      // itself…
      await squatter.disconnect("issue 2656 E1: nick freed");
      // …until the switch goes on. A live toggle tries at once. The budget
      // still covers one interval: if bahamut had not yet processed the
      // squatter's QUIT when that first try arrived, it drew a 433 (swallowed)
      // and the nick comes back at the next try.
      await setKeepNick(token, NETWORK_SLUG, true);
      await expect.poll(liveNick, { timeout: KEEPNICK_INTERVAL_MS + SLACK_MS }).toBe(requested);
    } finally {
      await squatter.disconnect("issue 2656 E1 done").catch(() => {});
    }
  });

  test("E2. switch on at connect, a held nick is asked for again in silence, and taken when it frees", async () => {
    const requested = specUser().name;
    const token = specUser().token;

    await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "parked" });
    // Set while parked, so the session STARTS with it: the SessionPlan path,
    // not the live toggle E1 covers.
    await setKeepNick(token, NETWORK_SLUG, true);
    const squatter = await IrcPeer.connect({ nick: requested });
    try {
      const t0 = await registerDrifted(token, requested);

      // Past the first try with the squatter still holding the nick: that
      // try drew a 433, and keepnick swallowed it.
      await new Promise((r) => setTimeout(r, FIRST_TRY_MS + SLACK_MS));
      expect(await liveNick()).not.toBe(requested);
      expect(
        (await serverRowsSince(token, t0)).filter((r) => numeric(r) === 433),
        "a refused try of keepnick's own must not reach $server (E1 shows the row when it is off)",
      ).toEqual([]);

      await squatter.disconnect("issue 2656 E2: nick freed");

      // Taken at the NEXT try. With the switch off the only try was already
      // spent, so this convergence is the re-arm itself.
      await expect.poll(liveNick, { timeout: KEEPNICK_INTERVAL_MS + SLACK_MS }).toBe(requested);
      expect((await serverRowsSince(token, t0)).filter((r) => numeric(r) === 433)).toEqual([]);
      expect(
        (await serverRowsSince(token, t0)).filter((r) => keepNickStop(r) !== undefined),
      ).toEqual([]);
    } finally {
      await squatter.disconnect("issue 2656 E2 done").catch(() => {});
    }
  });

  test("E4. moderated on a channel when the nick frees: bahamut's 437 shows, keepnick says it stopped, and asks no more", async () => {
    const requested = specUser().name;
    const token = specUser().token;
    const channel = `#i2656-${crypto.randomUUID().slice(0, 6)}`;

    await patchNetworkConnectionState(token, NETWORK_SLUG, { connection_state: "parked" });
    const squatter = await IrcPeer.connect({ nick: requested });
    try {
      const t0 = await registerDrifted(token, requested);

      // The squatter founds the channel (so it holds ops) and moderates it;
      // the subject joins without voice. bahamut answers a NICK from a
      // member of a `+m` channel it cannot speak in with 437
      // ERR_BANNICKCHANGE `[own, #chan, …]` — but only once the nick is
      // free, because it checks collision (433) first.
      await squatter.join(channel);
      await squatter.mode(channel, "+m");
      await joinChannel(token, NETWORK_SLUG, channel);
      await expect
        .poll(
          async () => {
            const rows = await fetchAllMessagesAsc(token, NETWORK_SLUG, channel);
            return rows.some((r) => r.kind === "join" && r.server_time >= t0);
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // On live: an immediate try, which the held nick answers with 433
      // (swallowed). The next try is a full interval later.
      await setKeepNick(token, NETWORK_SLUG, true);
      await squatter.disconnect("issue 2656 E4: nick freed");

      await expect
        .poll(
          async () =>
            (await serverRowsSince(token, t0)).filter((r) => keepNickStop(r) !== undefined),
          { timeout: KEEPNICK_INTERVAL_MS + SLACK_MS },
        )
        .toHaveLength(1);

      const rows = await serverRowsSince(token, t0);
      const refusals = rows.filter((r) => numeric(r) === 437);
      expect(
        refusals,
        "the refusal itself still routes to $server — it is why the nick does not come back",
      ).toHaveLength(1);
      expect(rows.find((r) => keepNickStop(r) !== undefined)?.meta?.keep_nick).toEqual({
        outcome: "stopped",
        target: requested,
        numeric: 437,
      });
      expect(
        rows.filter((r) => numeric(r) === 433),
        "no refusal of a held-nick try reaches $server",
      ).toEqual([]);

      // Asks no more: a chain that kept going would draw a second 437 one
      // interval later.
      await new Promise((r) => setTimeout(r, KEEPNICK_INTERVAL_MS + SLACK_MS));
      expect((await serverRowsSince(token, t0)).filter((r) => numeric(r) === 437)).toHaveLength(1);
      expect(await liveNick()).not.toBe(requested);
    } finally {
      await squatter.disconnect("issue 2656 E4 done").catch(() => {});
    }
  });
});
