// Slash-commands bundle (commit 24eb1d8 — issues #20, #22, #23) — e2e
// for the user-visible UX from that bundle. Vitest covers the parser
// (`slashCommands.test.ts` +36 tests) and elixir covers the server-
// side validators; this is the missing browser-side smoke that per
// `feedback_ux_e2e_mandatory` MUST ship alongside any cic UX-behavior
// change.
//
// Scope (smoke, not exhaustive — one assertion per load-bearing path):
//   1. /j auto-prepends `#` when the first char isn't an RFC channel
//      prefix → JOIN row persists at `#name`, sidebar gains the entry.
//   2. /topic <body> on a channel window updates that channel's topic
//      via the (#22) post-fix single-persist EventRouter path → TOPIC
//      row persisted (kind="topic", body=new topic).
//   3. /topic #other <body> from a DIFFERENT window operates on the
//      named channel — issue #23 context-aware split.
//   4. /q on a query window closes it (sidebar entry gone). Opened via
//      /msg <nick> then closed via bare /q.
//   5. /quote <raw line> reaches upstream — assert via a server-side
//      effect (we send `QUOTE PING grappa-test` and confirm it doesn't
//      crash the session; a stricter PONG round-trip would need a
//      raw-IRC sink we don't have).
//
// Out of scope:
//   - /oper: requires a real upstream O:line that the e2e network
//     doesn't carry. Covered by elixir + vitest unit tests
//     (Identifier.safe_oper_token?/1, GrappaChannel :oper_token
//     validator, Session.Server credential-order-swap log sentinel).
//   - /cs /ns /ms /os /hs /rs service aliases: the cic-side parser
//     rewrite is fully unit-covered (slashCommands.test.ts +N tests).
//     Asserting end-to-end would require a live ChanServ NOTICE
//     reply which the test ircd doesn't bridge.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Per-run unique channel + nick so /join's autojoin persistence +
// query-window opens don't bleed across runs.
const runId = () => crypto.randomUUID().slice(0, 8);

test.describe("slash-commands bundle (24eb1d8 — issues #20, #22, #23)", () => {
  test("/j auto-prepends # when no RFC channel-prefix is given", async ({ page }) => {
    const vjt = getSeededVjt();
    const newChannel = `#slash-j-${runId()}`;
    const bareName = newChannel.slice(1); // strip leading #

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, newChannel)).toHaveCount(0);

    // Type `/j bareName` (no `#`) — the bundle's auto-prefix should
    // turn it into `JOIN #bareName` upstream.
    try {
      await composeSend(page, `/j ${bareName}`);
      await expect(sidebarWindow(page, NETWORK_SLUG, newChannel)).toBeVisible({
        timeout: 10_000,
      });
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: newChannel,
        sender: NETWORK_NICK,
        kind: "join",
      });
    } finally {
      await partChannel(vjt.token, NETWORK_SLUG, newChannel).catch(() => {});
    }
  });

  test("/topic <body> on a channel window updates that channel's topic", async ({ page }) => {
    const vjt = getSeededVjt();
    const newTopic = `topic-from-slash-${runId()}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

    await composeSend(page, `/topic ${newTopic}`);

    // Post-#22 fix: the optimistic persist was dropped in
    // Session.Server.handle_call({:send_topic, _}); EventRouter's
    // unsolicited-TOPIC handler is the single persist path. The
    // round-trip takes one upstream RTT — `assertMessagePersisted`
    // polls up to 5s by default.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: SEED_CHANNEL,
      sender: NETWORK_NICK,
      body: newTopic,
      kind: "topic",
    });
  });

  test("/topic #channel <body> from any window operates on the named channel (#23)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const otherChannel = `#slash-topic-${runId()}`;
    const newTopic = `cross-window-topic-${runId()}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

    try {
      // Join a second channel so we have a target that isn't the
      // currently-selected one.
      await composeSend(page, `/join ${otherChannel}`);
      await expect(sidebarWindow(page, NETWORK_SLUG, otherChannel)).toBeVisible({
        timeout: 10_000,
      });

      // STAY on SEED_CHANNEL — do NOT select otherChannel. /topic
      // #other <body> must operate on the named channel regardless
      // of the active window selection (#23 context-aware parser).
      await composeSend(page, `/topic ${otherChannel} ${newTopic}`);

      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: otherChannel,
        sender: NETWORK_NICK,
        body: newTopic,
        kind: "topic",
      });
    } finally {
      await partChannel(vjt.token, NETWORK_SLUG, otherChannel).catch(() => {});
    }
  });

  test("/q on a query window closes that window (bucket B)", async ({ page }) => {
    const vjt = getSeededVjt();
    // Arbitrary peer nick — bahamut-test accepts PRIVMSG to any nick;
    // cic optimistically opens the query window via /msg-handler
    // openQueryWindowState. Existing specs (cic-members-panel-scope,
    // bug7-m6) use the same arbitrary-nick pattern.
    const peerNick = `slash-q-peer-${runId()}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

    // Open a query window via /msg — compose.ts /msg handler calls
    // openQueryWindowState which mounts the window in the sidebar
    // AND `setSelectedChannel({kind: "query"})` (compose.ts:306) so
    // selection is on the query window immediately — no further
    // selectChannel needed (a re-click could race the setSelection).
    await composeSend(page, `/msg ${peerNick} hello`);
    const queryWindow = sidebarWindow(page, NETWORK_SLUG, peerNick);
    await expect(queryWindow).toBeVisible({ timeout: 10_000 });

    // Bare /q closes the active query window. Drop expectUnmount —
    // the compose textarea stays mounted on the post-close selection
    // (Home or another channel); compose's submit clears the draft
    // signal so `toHaveValue("")` is the correct synchronous signal.
    await composeSend(page, "/q");

    // Sidebar entry gone.
    await expect(queryWindow).toHaveCount(0, { timeout: 5_000 });
  });

  test("/quote PING reaches the upstream wire without crashing the session", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const cookie = runId();

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

    // /quote PING <cookie> — server-side escape hatch added in
    // bucket C (Client.send_raw → Session.send_raw → handle_in("raw", _)).
    // Upstream will respond with PONG; we don't have a raw-IRC sink
    // to assert the PONG echo, but a CRLF/NUL-injection attempt
    // would crash the Session.Server and break the next composeSend.
    // The two follow-up assertions confirm the session is still
    // alive after /quote:
    //   - we can send a regular PRIVMSG and it persists.
    //   - the session's bearer still authenticates against /me
    //     (covered transitively by the persist assertion).
    await composeSend(page, `/quote PING ${cookie}`);
    await composeSend(page, `liveness-after-quote-${cookie}`);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: SEED_CHANNEL,
      sender: NETWORK_NICK,
      body: `liveness-after-quote-${cookie}`,
      kind: "privmsg",
    });
  });
});
