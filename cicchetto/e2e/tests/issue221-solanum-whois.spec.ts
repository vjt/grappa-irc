// #221 — solanum-node WIRE-CONTRACT proof. The azzurra2 network runs
// SOLANUM (the ircd Libera.Chat runs) since #221. This spec validates the
// solanum-specific WHO-mask wire shape that grappa's gap-(c) fix depends
// on — against the REAL ircd, not an assumption:
//
//   - solanum answers a mask WHO's 352 RPL_WHOREPLY with the channel field
//     set to "*" (modules/m_who.c:507, `msptr ? chname : "*"`), and
//   - terminates with 315 RPL_ENDOFWHO echoing the ORIGINAL mask,
//   - even matching by NICK (m_who.c:334 matches nick/user/host/realname).
//
// That "*" channel field is the exact shape that broke grappa's
// channel-keyed who_fold correlation pre-#221 (grappa filed the rows under
// "*" but drained under the mask). Proving the real solanum emits it —
// where bahamut neither matches nick-masks nor is the ircd Libera runs —
// is the node's integration value: the grappa-side correlation fix
// (single-in-flight who_fold) is unit + Session.Server tested
// (event_router_test.exs / server_test.exs #221), and driven end-to-end
// through cic on the shared fixture in issue221-who-mask.spec.ts; this
// spec closes the loop by pinning the upstream contract on the real ircd.
//
// Driven via a direct IrcPeer to the solanum node (dialed by the
// bahamut-test2 alias the solanum-test2 service retains) — no cic /
// visitor-multinet path, so it is stable regardless of the visitor
// accretion-connect timing.

import { expect, test } from "../fixtures/test";
import { IrcPeer } from "../fixtures/ircClient";

// The solanum node carries the `bahamut-test2` docker-network alias (#221
// kept it so the azzurra2 seed resolves unchanged) — the SECOND network's
// ircd, distinct from the shared bahamut leaf.
const SOLANUM_HOST = "bahamut-test2";

test("#221 — solanum answers a mask WHO with 352 channel='*' + 315 echoing the mask", async () => {
  const stamp = Date.now() % 1000000;
  const nick = `solwho-${stamp}`;
  // Collect every server wire-line so we can assert the exact 352/315 shape.
  const lines: string[] = [];

  const peer = await IrcPeer.connect({ nick, host: SOLANUM_HOST });
  try {
    // Tap the raw wire (irc-framework re-emits every server line).
    // biome-ignore lint/suspicious/noExplicitAny: irc-framework client is untyped here
    const raw = (peer as unknown as { client: any }).client;
    raw.on("raw", (event: { line: string; from_server: boolean }) => {
      if (event.from_server) lines.push(event.line);
    });

    // solanum's global/mask WHO lists INVISIBLE users (+i, set by default on
    // connect) only via a COMMON channel — and that path stamps the 352 with
    // the channel name (m_who.c who_common_channel). The VISIBLE-users pass
    // is the one that stamps channel "*" (do_who(..., NULL, ...)). To
    // deterministically exercise the "*"-channel contract this spec targets,
    // drop +i so the peer is matched by the visible pass with no common
    // channel → channel field "*".
    raw.raw(["MODE", nick, "-i"]);

    // A nick-mask WHO. solanum matches the peer's own nick against the mask
    // (m_who.c:334); being a mask/global WHO on a now-visible user, the 352
    // channel field is "*". `client.raw` ships a bare WHO line.
    raw.raw(["WHO", `${nick}*`]);

    // Poll the captured lines for the 315 terminator (always emitted, even
    // on zero matches — m_who.c:294), then assert the shape.
    await expect
      .poll(() => lines.some((l) => / 315 /.test(l)), { timeout: 10_000 })
      .toBe(true);

    const reply352 = lines.find((l) => / 352 /.test(l));
    const reply315 = lines.find((l) => / 315 /.test(l));

    // 315 echoes the ORIGINAL mask argument.
    expect(reply315).toContain(`${nick}*`);

    // solanum matched the peer by nick → a 352 row exists, and its channel
    // field is "*", not a channel. This "*" is the exact wire shape that
    // broke grappa's channel-keyed who_fold correlation pre-#221.
    // `:solanum 352 <me> <chan> <user> <host> <server> <nick> <flags> :<hop> <real>`
    expect(reply352).toBeDefined();
    // Tokenise from the "352" numeric onward so a leading-`:` prefix (or its
    // absence in irc-framework's re-emitted line) doesn't shift indices.
    const tok = (reply352 as string).trim().split(/\s+/);
    const n = tok.indexOf("352");
    expect(n).toBeGreaterThanOrEqual(0);
    // After "352": [me, chan, user, host, server, nick, flags, ...]
    expect(tok[n + 2]).toBe("*"); // channel field
    expect(tok[n + 6]).toBe(nick); // matched nick
  } finally {
    await peer.disconnect("#221 solanum wire-contract done");
  }
});
