import { type Channel, Socket } from "phoenix";
import { createEffect, createRoot, on } from "solid-js";
import { channelPushError } from "./api";
import { token } from "./auth";
import { canonicalChannel } from "./channelKey";
import { recordSocketClose, recordSocketError, recordSocketOpen } from "./socketHealth";

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
    // SocketHealth wiring — single install at construction time so the
    // banner reflects every transition, including silent retry loops
    // (e.g. server's check_origin rejecting the browser Origin).
    // phoenix.js's onError fires per WS open attempt that fails;
    // onClose fires with a CloseEvent we can read code/reason from.
    _socket.onOpen(() => recordSocketOpen());
    _socket.onError(() => recordSocketError());
    _socket.onClose((closeEvent: CloseEvent | undefined) => recordSocketClose(closeEvent));
  }
  return _socket;
}

createRoot(() => {
  createEffect(
    on(token, (t, prev) => {
      if (t === null) {
        // Logout — drop the socket AND its module-level reference so a
        // subsequent login rebuilds from scratch. Pre-fix (2026-05-27)
        // we only called `_socket.disconnect()` but kept the instance;
        // the next login's `getSocket()` returned the disconnected
        // instance and its internal state (channels, refs, params
        // closure) carried the old session. phoenix.js's `connect()`
        // on a disconnected instance does NOT re-evaluate `params()`
        // reliably across the disconnect-reconnect boundary, so the
        // new bearer never landed on the handshake and the WS never
        // came back up after a visitor logout+relogin. Symptom:
        // network HTTP shows fresh POST /auth/login + GET /networks,
        // but the BEAM log shows zero `CONNECTED TO GrappaWeb.UserSocket`
        // and zero JOINED grappa:user:... events for the new visitor id.
        if (_socket?.isConnected()) _socket.disconnect();
        _socket = null;
        _userChannel = null;
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
export function joinUser(userName: string, onJoinOk?: (reply: unknown) => void): Channel {
  const topic = `grappa:user:${userName}`;
  const ch = getSocket().channel(topic);
  ch.join()
    .receive("ok", (reply: unknown) => {
      if (onJoinOk) onJoinOk(reply);
    })
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

export function joinChannel(
  userName: string,
  networkSlug: string,
  channelName: string,
  onJoinOk?: (reply: unknown) => void,
): Channel {
  // UX-4 bucket A — canonicalise channel-shape segment so cic joins
  // the same Phoenix topic the server broadcasts on. Server-side
  // `Grappa.PubSub.Topic.channel/3` canonicalises at build time; if
  // cic subscribed to `#Chan` while server emits on `#chan`, the
  // fastlane fan-out would skip this socket entirely. Nicks (DM
  // windows) pass through unchanged.
  const topic = `grappa:user:${userName}/network:${networkSlug}/channel:${canonicalChannel(channelName)}`;
  const ch = getSocket().channel(topic);
  // Surface server-side join failures to the console + Phase 5
  // telemetry hook (the `unknown topic` and `forbidden` shapes the
  // server returns from `GrappaChannel.join/3` would otherwise vanish
  // silently). `timeout` is the phoenix.js retry-budget exhaustion
  // shape; logging it lets a stuck channel show up in operator
  // browser-console output during diagnosis.
  //
  // `onJoinOk` (message-replay-on-reconnect cluster, 2026-05-12) fires
  // on EVERY successful join — both the initial join and every
  // auto-rejoin after a socket disconnect. phoenix.js's
  // `Push.resend()` does NOT clear the `recHooks` list (only resets
  // ref/refEvent/receivedResp/sent), so a `.receive("ok", cb)`
  // registered once at first join keeps firing on subsequent rejoins.
  // The cic backfill flow uses this fan-in to detect "this is a
  // re-join" and fetch the rows that arrived during the WS gap.
  //
  // The join `reply` carries the per-channel cursor for CP29 R-4 read
  // state (`%{read_cursor: <id_or_nil>}`); subscribers narrow it via
  // `readCursor.ts:applyJoinReply/3`.
  ch.join()
    .receive("ok", (reply: unknown) => {
      if (onJoinOk) onJoinOk(reply);
    })
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  return ch;
}

// M-11 — join the admin-events channel (`grappa:admin:events`).
// Authz is `is_admin: true` server-side; non-admin sockets get
// `{:error, %{error: "forbidden"}}` and the .receive("error")
// arm fires. AdminPane.tsx gates the join on `me.is_admin`, so
// the forbidden branch is a defense-in-depth fallback rather
// than the expected path.
export function joinAdminEvents(): Channel {
  const topic = "grappa:admin:events";
  const ch = getSocket().channel(topic);
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] admin-events join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] admin-events join timed out", topic);
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
// as inline compose-box alerts, same as REST failures. Rejects with
// a typed `ChannelPushError` carrying the wire `code` ("no_session",
// "not_explicit", etc.) which compose.ts maps to human copy via
// `friendlyChannelError`.
export function pushAwaySet(network: string, reason: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push("away", { action: "set", network, reason })
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(channelPushError(err)));
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
      .receive("error", (err: unknown) => reject(channelPushError(err)));
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
// #154(1) — no-silent-drops. State-changing verbs (op/deop/voice/devoice/
// kick/ban/unban/mode/umode) push WITH a `.receive` chain and return a
// Promise, exactly like `pushOper`/`pushRaw`. Pre-fix they were
// fire-and-forget `: void`, so a server `{:error,_}` (visitor_not_allowed
// pre-#153, invalid_channel/nick/mask/line, no_session, upstream_unavailable,
// body_too_large) OR a WS-down was SILENTLY SWALLOWED — compose.ts painted a
// green ✓ on a dropped state-changing frame. `dispatch_subject_verb/3`
// already replies `{:reply, :ok | {:error, %{error: code}}}` for every one
// of these verbs; the compose.ts arms now `await` the Promise so a rejection
// propagates to the shared catch → `friendlyChannelError` inline alert.
//
// `banlist` stays fire-and-forget: it is a read-only query (367/368 numerics
// route back via the numeric pipeline), not a state-changing verb whose error
// must surface inline.
// ---------------------------------------------------------------------------

// Shared promise-shape push for the state-changing channel verbs. Mirrors the
// `pushOper`/`pushRaw` body: resolve on "ok", reject with a typed
// `ChannelPushError` (carrying the wire `code`) on "error", reject "not
// connected" when the socket is down. Single source of the ok/error contract
// so the nine verb helpers below can't drift from each other.
function pushUserChannelVerb(event: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push(event, payload)
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(channelPushError(err)));
  });
}

// /op <nicks...> → MODE #chan +ooo (chunked server-side per ISUPPORT MODES=).
export function pushChannelOp(networkId: number, channel: string, nicks: string[]): Promise<void> {
  return pushUserChannelVerb("op", { network_id: networkId, channel, nicks });
}

// /deop <nicks...> → MODE #chan -ooo
export function pushChannelDeop(
  networkId: number,
  channel: string,
  nicks: string[],
): Promise<void> {
  return pushUserChannelVerb("deop", { network_id: networkId, channel, nicks });
}

// /voice <nicks...> → MODE #chan +vvv
export function pushChannelVoice(
  networkId: number,
  channel: string,
  nicks: string[],
): Promise<void> {
  return pushUserChannelVerb("voice", { network_id: networkId, channel, nicks });
}

// /devoice <nicks...> → MODE #chan -vvv
export function pushChannelDevoice(
  networkId: number,
  channel: string,
  nicks: string[],
): Promise<void> {
  return pushUserChannelVerb("devoice", { network_id: networkId, channel, nicks });
}

// /kick <nick> [reason] → KICK #chan nick :reason
export function pushChannelKick(
  networkId: number,
  channel: string,
  nick: string,
  reason: string,
): Promise<void> {
  return pushUserChannelVerb("kick", { network_id: networkId, channel, nick, reason });
}

// /ban <mask-or-nick> → MODE #chan +b mask (mask derivation server-side if bare nick).
export function pushChannelBan(networkId: number, channel: string, mask: string): Promise<void> {
  return pushUserChannelVerb("ban", { network_id: networkId, channel, mask });
}

// /unban <mask> → MODE #chan -b mask
export function pushChannelUnban(networkId: number, channel: string, mask: string): Promise<void> {
  return pushUserChannelVerb("unban", { network_id: networkId, channel, mask });
}

// /banlist → MODE #chan b (query form, no sign); server replies 367/368.
// Read-only query — stays fire-and-forget (no error to surface inline).
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
export function pushChannelUmode(networkId: number, modes: string): Promise<void> {
  return pushUserChannelVerb("umode", { network_id: networkId, modes });
}

// /mode <target> <modes> [params...] → MODE target modes params (verbatim, no chunking).
export function pushChannelMode(
  networkId: number,
  target: string,
  modes: string,
  params: string[],
): Promise<void> {
  return pushUserChannelVerb("mode", { network_id: networkId, target, modes, params });
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

// Bundle C (#20 follow-up) — /oper <name> <password>. The password
// travels over the WS frame; the bouncer (Session.Server.handle_call
// {:send_oper, ...}) redacts it from any log line by emitting a
// static message body (no interpolation) before sending OPER upstream.
// Server replies arrive as 381 RPL_YOUREOPER (success) or 491 / 464
// (failure) numerics routed via the existing numeric-routing path.
//
// Returns a Promise (not fire-and-forget) so the compose box surfaces
// `invalid_line`, `visitor_not_allowed`, `no_session`, or disconnected
// (`not connected`) failures as inline alerts — credential-bearing
// verbs MUST NOT silently no-op (CLAUDE.md `feedback_no_silent_drops_closed`).
export function pushOper(networkId: number, name: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push("oper", { network_id: networkId, name, password })
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(channelPushError(err)));
  });
}

// Bundle C (#20 follow-up) — /quote <raw IRC line>. Same Promise shape
// as pushOper: a silently-dropped /quote leaves the operator typing into
// the void, so the compose-box error path MUST see WS-disconnected or
// server-side {:error,_} replies.
export function pushRaw(networkId: number, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_userChannel === null) {
      reject(new Error("not connected"));
      return;
    }
    _userChannel
      .push("raw", { network_id: networkId, line })
      .receive("ok", () => resolve())
      .receive("error", (err: unknown) => reject(channelPushError(err)));
  });
}

// /whois <nick> → WHOIS nick — pushes on the user-level channel.
// Server-side `handle_in("whois", ...)` handler in GrappaChannel is
// pending (C5 gap: cicchetto side landed; server side deferred to next bucket).
export function pushWhois(networkId: number, nick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("whois", { network_id: networkId, nick });
}

// P-0c — /whowas <nick> → WHOWAS nick — pushes on the user-level
// channel. Server primes whowas_pending + emits WHOWAS upstream;
// 314/312/369/406 fold into the bundle which broadcasts as
// `whowas_bundle` on Topic.user/1. cic dispatches in userTopic.ts
// and the WhowasCard renders inline above the active window.
export function pushWhowas(networkId: number, nick: string): void {
  if (_userChannel === null) return;
  _userChannel.push("whowas", { network_id: networkId, nick });
}

// CP22 cluster B (channel-client-polish #14) — /who <#channel>. Pushes
// on the user-level channel; server primes who_pending + emits WHO
// upstream. The 352/315 burst lands as N+1 :notice scrollback rows
// routed to the target channel (if joined) or $server (otherwise) —
// no client-side accumulator needed.
export function pushWho(networkId: number, channel: string): void {
  if (_userChannel === null) return;
  _userChannel.push("who", { network_id: networkId, channel });
}

// P-0d — /lusers → LUSERS upstream — bare verb, no args. Pushes on
// the user-level channel; server emits the 7-numeric bundle which
// EventRouter folds and 266 RPL_GLOBALUSERS flushes into a typed
// :lusers_bundle wire event on Topic.user/1. cic dispatches in
// userTopic.ts and renders the LusersCard in the $server window.
export function pushLusers(networkId: number): void {
  if (_userChannel === null) return;
  _userChannel.push("lusers", { network_id: networkId });
}

// #140 — /names <#channel>. Pushes on the user-level channel; server
// primes names_pending + emits NAMES upstream. The 353/366 burst drains
// into ONE ephemeral `names_reply` event on the user topic (NamesModal
// renders it) — NOT persisted. Network-scoped modal, so no origin window.
export function pushNames(networkId: number, channel: string): void {
  if (_userChannel === null) return;
  _userChannel.push("names", { network_id: networkId, channel });
}

// C8.3 — Watchlist verbs (/watch /highlight). All push on the user-level
// channel; server-side GrappaChannel.handle_in("watchlist", ...) handlers
// are the authority (added in C8 server-side commit). The Promise resolves
// with {patterns: string[]} on success, rejects on server error or timeout.
//
// Pattern semantics: forward-only (changing the list does NOT re-aggregate
// past scrollback; only future mentions are filtered by the new list).
export function pushWatchlistAdd(pattern: string): Promise<{ patterns: string[] }> {
  const ch = _userChannel;
  if (ch === null) return Promise.reject(new Error("not connected"));
  return new Promise((resolve, reject) => {
    ch.push("watchlist", { action: "add", pattern })
      .receive("ok", (reply: { patterns: string[] }) => resolve(reply))
      .receive("error", (err: unknown) => reject(channelPushError(err)))
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

export function pushWatchlistDel(pattern: string): Promise<{ patterns: string[] }> {
  const ch = _userChannel;
  if (ch === null) return Promise.reject(new Error("not connected"));
  return new Promise((resolve, reject) => {
    ch.push("watchlist", { action: "del", pattern })
      .receive("ok", (reply: { patterns: string[] }) => resolve(reply))
      .receive("error", (err: unknown) => reject(channelPushError(err)))
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

export function pushWatchlistList(): Promise<{ patterns: string[] }> {
  const ch = _userChannel;
  if (ch === null) return Promise.reject(new Error("not connected"));
  return new Promise((resolve, reject) => {
    ch.push("watchlist", { action: "list", pattern: undefined })
      .receive("ok", (reply: { patterns: string[] }) => resolve(reply))
      .receive("error", (err: unknown) => reject(channelPushError(err)))
      .receive("timeout", () => reject(new Error("timeout")));
  });
}

// E2E hook (message-replay-on-reconnect cluster, 2026-05-12) — drops
// the live socket and reconnects so Playwright can simulate the
// tab-suspend / network-blip / iOS-Safari-tab-resume gap class
// without juggling browser-context offline mode (which closes ALL
// connections including the REST fetches the test depends on).
//
// Drop emits `phx_close` on every joined Channel; phoenix.js
// auto-rejoins after the next `connect()`. The reconnect-backfill
// flow's onJoinOk callback fires on every successful re-join, so
// the gap-recovery path is exercised end-to-end. Keep gap >0ms so
// in-flight pushes drain before the new socket lands.
declare global {
  interface Window {
    __cic_dropSocketForTests?: () => Promise<void>;
  }
}

if (typeof window !== "undefined") {
  window.__cic_dropSocketForTests = async () => {
    const s = _socket;
    if (!s) return;
    s.disconnect();
    // Microtask boundary so phx_close fires before reconnect.
    await Promise.resolve();
    s.connect();
  };
}
