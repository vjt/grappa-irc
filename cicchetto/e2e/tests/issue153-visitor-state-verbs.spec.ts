// Issue #153 (P0) — a VISITOR may send every state-changing verb.
//
// Pre-#153 the GrappaChannel routed the state-mutating verbs (op/deop/
// voice/devoice/kick/ban/unban/umode/mode/topic_set/topic_clear) and the
// `/quote` raw escape hatch through `dispatch_ops_verb/3`, which gated on
// `check_not_visitor/1` → a visitor-backed socket got
// `{:error, :visitor_not_allowed}` and the verb NEVER reached upstream.
// #153 re-routes every verb onto `dispatch_subject_verb/3` (the same
// visitor-eligible helper #148 /oper and #31 /invite already used), so a
// visitor's verbs ride its OWN upstream IRC session exactly like a user's.
//
// What this covers, end-to-end, with an INDEPENDENT witness (a peer IRC
// client sharing the channel) — NOT merely "no error reply":
//   1. a `/quote PRIVMSG` raw line reaches upstream and is relayed to the
//      peer (proves the /quote escape hatch is de-gated for visitors), and
//   2. a `/mode #chan +m` state change reaches upstream and is relayed to
//      the peer as a MODE line (proves a channel-ops verb is de-gated).
// The peer only sees each line if bahamut APPLIED and relayed it — so the
// assertion is the visible upstream effect, not a client-side spy.
//
// Pre-#153 BOTH `peer.waitForLine(...)` promises time out (the verb is
// short-circuited with `visitor_not_allowed`, nothing is sent upstream)
// → RED. Post-#153 both lines land → GREEN.
//
// The visitor /OPERs first (testnet O:line creds, host-unrestricted; same
// as issue148-visitor-oper.spec.ts) so it can set channel modes without
// depending on the leaf's split-mode first-joiner-op behavior — ircops
// issue MODE freely on any channel they're in (see ircClient.oper docs).

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  scrollbackLine,
  selectChannel,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededAdmin } from "../fixtures/seedData";

// Stable core phrase of bahamut's 381 RPL_YOUREOPER trailing text
// (`:%s 381 %s :You are now an IRC Operator`) — matched as a regex so
// trivial wording drift doesn't break the connection gate. Same literal
// as issue148-visitor-oper.spec.ts.
const RPL_YOUREOPER_TEXT = /you are now an irc operator/i;

test("issue #153 — visitor /quote and /mode reach upstream and take effect", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitorNick = `v153-${stamp}`;
  const channel = `#t153-${stamp}`;
  const marker = `quote153-${stamp}`;
  const visitor = await mintVisitor(visitorNick);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let peer: IrcPeer | null = null;

  try {
    const visitorSubject = {
      kind: "visitor",
      id: visitor.id,
      nick: visitor.nick,
      network_slug: visitor.network_slug,
    };

    // Boot cic straight into Shell as the visitor (no captcha/anon dance),
    // exactly like issue148-visitor-oper.spec.ts.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [visitor.token, JSON.stringify(visitorSubject)] as const,
    );
    await page.goto("/");
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

    // Focus the visitor's $server window and wait for the upstream
    // registration numerics (001-005 / LUSER / MOTD → :notice rows). Their
    // presence proves the visitor's session is connected upstream.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // /oper up so the visitor can set channel modes regardless of the
    // leaf's split-mode first-joiner-op behavior. 381 RPL_YOUREOPER lands
    // in $server as a :notice — proves the oper took (and, incidentally,
    // that #148's visitor-oper carve-out still holds).
    await composeSend(page, "/oper testoper testoperpass");
    await expect(
      scrollbackLine(page, "notice", RPL_YOUREOPER_TEXT).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Gate the compose /join on the user-topic JOIN ack (window_pending
    // fastlanes only to subscribed sockets — see waitForUserTopicReady).
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);

    // Visitor JOINs the fresh per-spec channel, then focuses it. The tab
    // only appears once the server's window-state broadcast lands, and the
    // members pane only mounts once the channel is fully joined.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, visitor.network_slug, channel, { ownNick: visitor.nick });
    await expect(page.locator(".members-pane")).toBeVisible({ timeout: 10_000 });

    // Bring in an independent peer that shares the channel — it witnesses
    // the upstream effects the visitor's verbs produce.
    peer = await IrcPeer.connect({ nick: `peer153-${stamp}` });
    await peer.join(channel);

    // (1) /quote raw — a PRIVMSG the peer receives proves the raw escape
    // hatch reached upstream. Arm the witness BEFORE sending. Channel is
    // still unmoderated here (+m is set below), so the visitor speaks
    // freely. Pre-#153: `visitor_not_allowed` → nothing sent → timeout (RED).
    const privmsgWitness = peer.waitForLine(
      new RegExp(`PRIVMSG ${channel} :.*${marker}`, "i"),
      `visitor /quote PRIVMSG ${marker}`,
    );
    await composeSend(page, `/quote PRIVMSG ${channel} :${marker}`);
    await privmsgWitness;

    // (2) /mode #chan +m — a state-changing channel-ops verb. The peer
    // receives the MODE line only if bahamut applied it. Pre-#153:
    // `visitor_not_allowed` → nothing sent → timeout (RED).
    const modeWitness = peer.waitForLine(
      new RegExp(`MODE ${channel} \\+m`, "i"),
      `visitor /mode ${channel} +m`,
    );
    await composeSend(page, `/mode ${channel} +m`);
    await modeWitness;

    // The de-gated verbs never surface the removed rejection token.
    await expect(page.getByText(/visitor_not_allowed/i)).toHaveCount(0);
  } finally {
    if (peer) await peer.disconnect("issue153 done").catch(() => {});
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
