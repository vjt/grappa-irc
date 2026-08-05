// Issue #604 — IrcPeer.connect must survive a nick collision and reconcile
// `peer.nick` with the nick the server ACTUALLY registered.
//
// The real flake (#277): a residual ghost from a prior run still holds the
// nick a spec asks for. bahamut answers 433 ERR_NICKNAMEINUSE and waits for a
// fresh NICK, but irc-framework (4.14.0) does NOT auto-retry during
// registration — it only emits `nick in use`. So the peer either hangs until
// the register timeout, or (had it registered under an alternate) keeps
// believing the requested nick while the server granted a different one. Then
// every later helper keyed on `peer.nick` addresses a phantom: a DM / `/ping`
// to it lands nowhere and the spec waits out its full timeout, surfacing as an
// unrelated 15s locator flake wherever it happens to run.
//
// A clean testnet won't hand you the ghost — "re-running is what triggers it".
// So this FABRICATES the collision deterministically: a first peer holds the
// nick, a second peer requests the SAME one and earns the 433. `IrcPeer.connect`
// must then (a) retry onto a free alternate so registration completes, and
// (b) reconcile `peer.nick` to whatever the 001 RPL_WELCOME granted.
//
// (Aside — the issue's phrasing that irc-framework itself "registers the peer
// under an alternate nick" does not hold for 4.14.0: a plain 433 during
// registration just stalls. The retry lives in the fixture; the reconcile then
// mirrors irc-framework's own client.user.nick, which IS set from the 001.)
//
// Pure-peer test: no cic/browser, so it uses the bare @playwright/test `test`
// (no vjt-reset / CSP auto-fixtures) and never touches `page`.

import { expect, test } from "@playwright/test";
import { IrcPeer } from "../fixtures/ircClient";

// Unique-per-run so a KEEP_STACK rerun can't collide with its own ghost.
function uniqueNick(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

test("#604 — connect survives a 433 collision, reconciling peer.nick so a DM reaches the real peer", async () => {
  const nick = uniqueNick("n604");

  // The holder claims the nick, so the second identical request earns a
  // deterministic 433 (the fabricated ghost).
  const holder = await IrcPeer.connect({ nick });
  try {
    // Pre-fix this hangs on the 433 (no retry) and throws at REGISTER_TIMEOUT_MS.
    const peer = await IrcPeer.connect({ nick });
    try {
      // Reconciled OFF the requested (held) nick to the server-granted alternate.
      expect(peer.nick).not.toBe(nick);

      // The outcome the flake actually cares about: a DM keyed on `peer.nick`
      // reaches THIS peer, not the holder and not a phantom. If reconcile were
      // missing, `peer.nick` would still be the held nick — the DM would land
      // on the holder (irc-framework doesn't echo own sends) and this would
      // time out. The send is the wait's trigger, so the listener is
      // attached before it goes out (#806).
      const token = `dm604-${crypto.randomUUID().slice(0, 8)}`;
      await peer.waitForPrivmsg(holder.nick, token, () => holder.privmsg(peer.nick, token));
    } finally {
      await peer.disconnect("bye #604");
    }
  } finally {
    await holder.disconnect("bye #604");
  }
});
