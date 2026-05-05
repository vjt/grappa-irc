import { type Channel, Socket } from "phoenix";
import { createEffect, createRoot, on } from "solid-js";
import { token } from "./auth";

// Phoenix Channels singleton. Mirrors `auth.ts`'s module-singleton shape:
// every component that needs the live event-push surface joins via the
// helpers here; one Socket per browser tab regardless of how many call
// sites subscribe.
//
// Lazy construction: `getSocket()` builds the Socket on first call (i.e.
// the first time something tries to join). Until then nothing connects
// — RequireAuth bounces unauthenticated visitors to /login before any
// channel-needing component renders, so the lazy path means we don't
// even try to open a WS without a bearer.
//
// Token-driven lifecycle: phoenix.js evaluates the Socket's `params`
// callback only at WS-handshake time, so a live connection stays
// pinned to whatever bearer the handshake captured. Three transitions
// matter — login (null → t: connect), logout (t → null: disconnect),
// and rotation (a → b, both non-null and distinct: disconnect+connect
// to flush the new bearer onto the next handshake). Phase 5
// token-refresh and admin-driven re-issue both ride this path; without
// the rotation arm they would silently route under the stale identity.
// `on(token, fn)` gives us the prev value the rotation check needs;
// createRoot anchors the effect since module-level effects need an
// owner.
//
// Rotation side-effect: dropping the socket fires `phx_close` on every
// joined channel; phoenix.js auto-rejoins on the next `connect()`, so
// the rotation triggers a clean tear-down + rejoin loop across all
// active topics. Any in-flight `ch.join()` whose handshake was mid-
// rotation either completes against the old socket then immediately
// tears down, or errors out and rejoins under the new bearer. Phase 5
// telemetry should observe the rejoin volume on rotation events.
//
// Topic vocabulary mirrors `Grappa.PubSub.Topic` exactly. Don't
// reformat segment separators or re-encode identifiers — the server's
// `Topic.parse/1` is the authority and accepts these byte-for-byte.

let _socket: Socket | null = null;

// Module-level reference to the joined user-level channel. Set by
// `joinUser` so `notifyClientClosing` can push the `client_closing`
// event on pagehide / beforeunload without passing the channel reference
// around to every call site.
let _userChannel: Channel | null = null;

function getSocket(): Socket {
  if (_socket === null) {
    _socket = new Socket("/socket", {
      params: () => ({ token: token() ?? "" }),
    });
  }
  return _socket;
}

createRoot(() => {
  createEffect(
    on(token, (t, prev) => {
      if (t === null) {
        if (_socket?.isConnected()) _socket.disconnect();
        return;
      }
      const s = getSocket();
      if (prev != null && prev !== t) {
        // Token rotation: live socket is pinned to `prev`; drop and
        // reconnect so the params callback returns `t` on the next
        // handshake.
        if (s.isConnected()) s.disconnect();
        s.connect();
        return;
      }
      if (!s.isConnected()) s.connect();
    }),
  );
});

// joinUser + joinChannel mirror Topic.user/1 + Topic.channel/3 from the
// server. `joinNetwork` (per-(user, network) shape) is reserved
// infrastructure on the server side but has no cicchetto consumer yet —
// add it back when a real consumer (presence per network, MOTD on the
// per-user topic, etc.) needs it.
export function joinUser(userName: string): Channel {
  const topic = `grappa:user:${userName}`;
  const ch = getSocket().channel(topic);
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  // Track the user-level channel for the pagehide immediate-away hint (S3.3).
  _userChannel = ch;
  return ch;
}

export function joinChannel(userName: string, networkSlug: string, channelName: string): Channel {
  const topic = `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}`;
  const ch = getSocket().channel(topic);
  // Surface server-side join failures to the console + Phase 5
  // telemetry hook (the `unknown topic` and `forbidden` shapes the
  // server returns from `GrappaChannel.join/3` would otherwise vanish
  // silently). `timeout` is the phoenix.js retry-budget exhaustion
  // shape; logging it lets a stuck channel show up in operator
  // browser-console output during diagnosis.
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  return ch;
}

// S3.3 — pagehide immediate-away hint.
//
// Pushes `client_closing` over the active user-level channel so the
// server's WSPresence fires `:ws_all_disconnected` immediately —
// bypassing the 30s auto-away debounce — if this is the last socket
// for the user. No-op if no user channel has been joined yet (which
// can happen if the page unloads before `joinUser` completes).
//
// The push is fire-and-forget: `pagehide` / `beforeunload` give no
// time to await a reply. The server handles idempotency — the pid DOWN
// from the real socket close is a no-op if client_closing already
// fired the notification.
export function notifyClientClosing(): void {
  if (_userChannel === null) return;
  _userChannel.push("client_closing", {});
}

// S3.4 — /away slash-command pushes.
//
// Both variants push on the user-level channel and return a Promise
// that resolves on "ok" or rejects on "error" (mirrors the `away`
// handle_in reply shape from GrappaChannel). Callers (compose.ts)
// await the promise inside the submit try/catch so errors surface
// as inline compose-box alerts, same as REST failures.
export function pushAwaySet(network: string, reason: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push("away", { action: "set", network, reason })
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(new Error(String(err))));
  });
}

export function pushAwayUnset(network: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push("away", { action: "unset", network })
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(new Error(String(err))));
  });
}

// C1.4 — open a DM (query) window. Pushes `open_query_window` on the
// user-level channel; the server upserts the `query_windows` row and
// broadcasts `query_windows_list` back. Fire-and-forget — the
// authoritative update arrives via the broadcast event.
export function pushOpenQueryWindow(networkId: number, targetNick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("open_query_window", { network_id: networkId, target_nick: targetNick });
}

// C1.2 — close a DM (query) window. Pushes `close_query_window` on
// the user-level channel; the server deletes the `query_windows` row
// and broadcasts `query_windows_list` back. Fire-and-forget.
export function pushCloseQueryWindow(networkId: number, targetNick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("close_query_window", { network_id: networkId, target_nick: targetNick });
}

// ---------------------------------------------------------------------------
// S5.3 — Channel ops push helpers. All push on the user-level channel to
// GrappaChannel, which handles all topics (user, network, channel) in the
// same module. Auth is by user_name from socket.assigns; the server
// dispatches to Session.send_*/2-5 functions.
//
// Fire-and-forget: the server's numeric error replies (482, 401, etc.)
// route back via the numeric-routing pipeline (S4) to the originating
// window — we don't await acks here.
// ---------------------------------------------------------------------------

// /op <nicks...> → MODE #chan +ooo (chunked server-side per ISUPPORT MODES=).
export function pushChannelOp(networkId: number, channel: string, nicks: string[]): void {
  if (_userChannel === null) return;
  _userChannel.push("op", { network_id: networkId, channel, nicks });
}

// /deop <nicks...> → MODE #chan -ooo
export function pushChannelDeop(networkId: number, channel: string, nicks: string[]): void {
  if (_userChannel === null) return;
  _userChannel.push("deop", { network_id: networkId, channel, nicks });
}

// /voice <nicks...> → MODE #chan +vvv
export function pushChannelVoice(networkId: number, channel: string, nicks: string[]): void {
  if (_userChannel === null) return;
  _userChannel.push("voice", { network_id: networkId, channel, nicks });
}

// /devoice <nicks...> → MODE #chan -vvv
export function pushChannelDevoice(networkId: number, channel: string, nicks: string[]): void {
  if (_userChannel === null) return;
  _userChannel.push("devoice", { network_id: networkId, channel, nicks });
}

// /kick <nick> [reason] → KICK #chan nick :reason
export function pushChannelKick(
  networkId: number,
  channel: string,
  nick: string,
  reason: string,
): void {
  if (_userChannel === null) return;
  _userChannel.push("kick", { network_id: networkId, channel, nick, reason });
}

// /ban <mask-or-nick> → MODE #chan +b mask (mask derivation server-side if bare nick).
export function pushChannelBan(networkId: number, channel: string, mask: string): void {
  if (_userChannel === null) return;
  _userChannel.push("ban", { network_id: networkId, channel, mask });
}

// /unban <mask> → MODE #chan -b mask
export function pushChannelUnban(networkId: number, channel: string, mask: string): void {
  if (_userChannel === null) return;
  _userChannel.push("unban", { network_id: networkId, channel, mask });
}

// /banlist → MODE #chan b (query form, no sign); server replies 367/368.
export function pushChannelBanlist(networkId: number, channel: string): void {
  if (_userChannel === null) return;
  _userChannel.push("banlist", { network_id: networkId, channel });
}

// /invite <nick> [#chan] → INVITE nick #chan
export function pushChannelInvite(networkId: number, channel: string, nick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("invite", { network_id: networkId, channel, nick });
}

// /umode <modes> → MODE own_nick <modes> (no channel context required).
export function pushChannelUmode(networkId: number, modes: string): void {
  if (_userChannel === null) return;
  _userChannel.push("umode", { network_id: networkId, modes });
}

// /mode <target> <modes> [params...] → MODE target modes params (verbatim, no chunking).
export function pushChannelMode(
  networkId: number,
  target: string,
  modes: string,
  params: string[],
): void {
  if (_userChannel === null) return;
  _userChannel.push("mode", { network_id: networkId, target, modes, params });
}

// /topic -delete → TOPIC #chan : (empty trailing — irssi convention).
export function pushChannelTopicClear(networkId: number, channel: string): void {
  if (_userChannel === null) return;
  _userChannel.push("topic_clear", { network_id: networkId, channel });
}

// /topic <text> → TOPIC #chan :text (pushed via channel event, not REST postTopic).
// Note: compose.ts uses the existing postTopic REST path for topic-set; this helper
// is provided for completeness and alternative call sites.
export function pushChannelTopicSet(networkId: number, channel: string, text: string): void {
  if (_userChannel === null) return;
  _userChannel.push("topic_set", { network_id: networkId, channel, text });
}

// /whois <nick> → WHOIS nick — pushes on the user-level channel.
// Server-side `handle_in("whois", ...)` handler in GrappaChannel is
// pending (C5 gap: cicchetto side landed; server side deferred to next bucket).
export function pushWhois(networkId: number, nick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("whois", { network_id: networkId, nick });
}
