import { assertNever, type ChannelPushError } from "./api";
import { ERROR_TOKENS_CHANNEL_ERROR_TOKEN, type ErrorTokensChannelErrorToken } from "./wireTypes";

// Issue #62: channel-push rejections (`ChannelPushError`) were swallowed by
// compose.ts into a bare "send failed", hiding the real reason. The live
// incident: a visitor's `/away` surfaced "Send failed" with no clue it was a
// server rejection (`visitor_no_away`, since removed). This is the
// channel-push sibling of `friendlyApiError` (REST): one closed-union
// token → human copy module. Per `feedback_no_localized_strings_server_side`
// cic owns the human copy for every typed server error.
//
// Codes are the `error:` wire tokens emitted by the user-level
// `GrappaChannel.handle_in` arms (and `AdminChannel.join`) that cicchetto
// pushes WITH a reply and awaits — `/away`, the ops verbs, the watchlist
// verbs, `resolve_userhost`, `open_query_window`, topic set, etc.
//
// #411 D6b — the union AND the runtime narrowing Set are GENERATED, not
// hand-listed. `ErrorTokensChannelErrorToken` + `ERROR_TOKENS_CHANNEL_ERROR_TOKEN`
// come from `mix grappa.gen_wire_types` reading
// `GrappaWeb.ErrorTokens.channel_error_token` — the server's authoritative
// channel-push wire-token set. This DELIBERATELY OVERTURNS the pre-#411
// "curated subset + loud fallback for unmapped arms" design this comment used
// to defend: the union is the FULL server contract, so the ONLY hand-kept
// structure left is the switch (the copy — product). Adding a server-side
// token now: the codegen widens the union, `assertNever` in the `default` arm
// forces a `case` at `tsc` time, and you ship the vitest row. Ruling: "ogni
// cazzo di errore deve avere un copy" (#411). A token the server no longer
// emits (e.g. `visitor_no_away`) drops out of the server type → out of the
// generated union → its dead `case` becomes a `tsc` error, so dead arms
// can't linger. The `!isKnownCode` fallback to `err.message` is now a DRIFT
// guard (server ahead of codegen / off-contract string), not the home of
// un-localized tokens. One arm, one contract.

// The generated `ERROR_TOKENS_CHANNEL_ERROR_TOKEN` array is the single source
// for both the compile-time union and this runtime narrowing Set.
const KNOWN_CODES: ReadonlySet<ErrorTokensChannelErrorToken> = new Set(
  ERROR_TOKENS_CHANNEL_ERROR_TOKEN,
);

function isKnownCode(code: string): code is ErrorTokensChannelErrorToken {
  return KNOWN_CODES.has(code as ErrorTokensChannelErrorToken);
}

// #630 — the coarse per-subject request budget (spanning every WS verb +
// every REST write) refuses an over-budget frame with the `rate_limited`
// token — the WS twin of the send door's HTTP 429. To the user it is the
// SAME "slow down" signal, just across all verbs rather than just sends,
// so it reuses the send-throttle copy. Exported so `friendlyError.ts`'s
// REST `ApiError` `rate_limited` arm shares ONE string (implement once).
export const SEND_THROTTLED_COPY =
  "You're sending too fast — the server is throttling you. Slow down and try again in a moment.";

export function friendlyChannelError(err: ChannelPushError): string {
  if (!isKnownCode(err.code)) return err.message;
  return friendlyKnown(err.code);
}

function friendlyKnown(code: ErrorTokensChannelErrorToken): string {
  switch (code) {
    case "no_session":
      // The `(subject, network)` has no live `Session.Server` — e.g. a
      // visitor whose session hasn't connected, or a network that's parked.
      return "You're not connected to that network right now.";
    case "not_explicit":
      // `/away` (bare, to clear) issued while not in `:away_explicit` —
      // mirrors `Session.unset_explicit_away/2`'s `{:error, :not_explicit}`.
      return "You're not marked away.";
    case "network_not_found":
      return "That network doesn't exist.";
    case "user_not_found":
      return "Your account couldn't be found. Try logging in again.";
    case "invalid_reason":
      // The away reason contained CR/LF/NUL — rejected at the IRC framing
      // boundary by `Identifier.safe_line_token?/1`.
      return "That away message contains characters that aren't allowed.";
    case "invalid_channel":
      // `Identifier.valid_channel?/1` rejected the channel token.
      return "That channel name isn't valid.";
    case "invalid_nick":
      // `Identifier.valid_nick?/1` rejected a nick token (op/deop/voice/
      // devoice/kick target).
      return "That nickname isn't valid.";
    case "invalid_mask":
      // `Identifier.safe_line_token?/1` rejected the ban mask (empty or
      // CR/LF/NUL).
      return "That ban mask isn't valid.";
    case "invalid_line":
      // A free-form token (kick reason, umode/mode string) contained
      // CR/LF/NUL — rejected at the IRC framing boundary.
      return "That contains characters that aren't allowed.";
    case "upstream_unavailable":
      // `Session.send_*` hit a dead upstream socket (no_socket / closed /
      // :inet.posix()). The bouncer is up but the IRC link is down.
      return "The server didn't accept that — the connection may be down.";
    case "body_too_large":
      // `BodyLimit.check/1` rejected an oversize kick reason / mode string
      // before it reached the upstream write.
      return "That's too long to send.";
    case "not_found":
      // #364 H (S5) — `/hilight del <pattern>` where the pattern isn't in
      // the keyword watchlist (`watchlist_del` → `{:error, :not_found}`).
      // An ordinary user action, so it needs friendly copy — distinct from
      // friendlyApiError's REST `not_found` ("network or resource").
      return "That pattern isn't in your highlight list.";
    case "save_failed":
      // #364 H (S5) — the `user_settings` write behind `/hilight add|del`
      // failed (`set_highlight_patterns` → `{:error, _}`). Rare (DB-side),
      // but a state-changing verb MUST NOT report a raw token.
      return "Couldn't save your highlight list — try again.";
    case "links_in_flight":
      // #513b — a second /links issued while one is still in flight is
      // refused (rather than clobbering the un-keyed topology accumulator and
      // silently dropping the first bundle). The in-flight request's map is
      // still coming; the user just retries once it lands.
      return "A network map request is already loading — try again in a moment.";
    case "unsupported_list_mode":
      // #1251 — a channel list-mode query for a letter this network doesn't
      // advertise as type A (or one grappa knows no reply numerics for). cic
      // only offers the server-published set, so reaching this means the
      // network's 005 changed under an open modal — the honest answer is
      // that the list isn't there, not that something failed.
      return "This network doesn't have that channel list.";

    // ── #411 D6b — the 8 previously-unmapped channel tokens (product copy,
    //    vetted by vjt). Same actionable-copy contract as the REST sibling.
    case "forbidden":
      // Shared token, channel side — `GrappaChannel.join` authorize / the
      // `AdminChannel` catch-all rejected the topic for this subject.
      return "You're not allowed to do that.";
    case "invalid_payload":
      // A malformed `visibility` / `away` payload (non-boolean, bad
      // `origin_window`) — a client bug, rejected at the boundary.
      return "That request was malformed. Please try again.";
    case "lookup_failed":
      // `resolve_userhost` catch-all (e.g. the Session.Server mailbox timed
      // out past the call deadline). Degrade to a typed retry, not a crash.
      return "Couldn't look that up right now. Try again.";
    case "not_cached":
      // `resolve_userhost` miss — no cached userhost for that nick yet. The
      // fail-closed signal cic surfaces as "run /whois first" (the mask
      // builder needs the host).
      return "We don't have that user's details yet — run /whois on them first.";
    case "open_failed":
      // `open_query_window` catch-all — the DM-window upsert failed.
      return "Couldn't open that conversation. Try again.";
    case "persist_failed":
      // `topic_set` catch-all — the topic change couldn't be persisted.
      return "Couldn't save that change. Try again.";
    case "unknown_event":
      // Terminal `handle_in` catch-all — an unknown frame name or a known
      // event with a wrong-typed field (a client/version-mismatch bug).
      return "That action isn't supported by the server.";
    case "unknown_topic":
      // `GrappaChannel.join` / `AdminChannel.join` on an unrecognized topic.
      return "That view isn't available.";

    // ── #523 / #518 — the WS sibling of `open_failed`. `close_query_window`
    //    couldn't ride out a sustained transient SQLite busy (the DM-window
    //    delete exhausted its BusyRetry budget → `{:error, :db_unavailable}`
    //    → the `close_failed` reply). Non-fatal: the socket stays open and the
    //    user just retries.
    case "close_failed":
      return "Couldn't close that conversation. Try again.";

    // ── #581 — /recover ("recover my identity") push rejections. The
    //    visitor-only guard emits the shared `forbidden` token (handled
    //    above), so only these three are recover-specific.
    case "nothing_to_recover":
      // The visitor has no recoverable credential (no stored NickServ
      // secret) — `handle_call(:recover_identity)` never blind-IDENTIFYs
      // (#561 pt3). Also the unconditional "nothing to do" outcome.
      return "There's nothing to recover — no saved identity on this network.";
    case "already_identified":
      // The session already holds `+r`, so there's nothing to reclaim.
      return "You're already identified on this network.";
    case "recovery_in_progress":
      // A recover sequence is already armed for this session (one FSM per
      // session — `{:error, :in_progress}`).
      return "Identity recovery is already in progress.";

    case "rate_limited":
      // #630 — over the coarse per-subject request budget. Same "slow
      // down" meaning as the send door's 429; reuse its copy (SSOT above).
      return SEND_THROTTLED_COPY;

    default:
      // Exhaustiveness: adding a token to the generated union without a
      // `case` arm narrows `code` to `never` only when every member is
      // handled, so this becomes a tsc compile error.
      return assertNever(code);
  }
}
