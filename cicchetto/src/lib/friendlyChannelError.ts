import { assertNever, type ChannelPushError } from "./api";

// Issue #62: channel-push rejections (`ChannelPushError`) were swallowed by
// compose.ts into a bare "send failed", hiding the real reason. The live
// incident: a visitor's `/away` surfaced "Send failed" with no clue it was a
// server rejection (`visitor_no_away`, since removed). This is the
// channel-push sibling of `friendlyApiError` (REST): one closed-union
// token → human copy module, with a loud fallback for unmapped arms
// (`err.message` carries the raw `channel push error: <code>` string, so an
// unmapped arm is operator-visible — no silent drop). Per
// `feedback_no_localized_strings_server_side` cic owns the human copy for
// every typed server error.
//
// Codes are the `error:` wire tokens emitted by the user-level
// `GrappaChannel.handle_in` arms that cicchetto pushes WITH a reply and
// awaits: `away` set/unset (socket.ts `pushAwaySet` / `pushAwayUnset`) and,
// since #154(1), the state-changing ops verbs (op/deop/voice/devoice/kick/
// ban/unban/mode/umode) which now await via `pushUserChannelVerb`. Those
// verbs route through `dispatch_subject_verb/3` (+ the `with_body_check`
// wrapper for kick/umode/mode), whose `else` arms emit `invalid_channel`,
// `invalid_nick`, `invalid_mask`, `invalid_line`, `no_session`,
// `user_not_found`, `upstream_unavailable`, and `body_too_large`. Adding a
// token: add it to the union, add a `case`, ship the vitest arm. Tokens the
// server no longer emits (e.g. `visitor_no_away`) MUST NOT be mapped — a dead
// arm is silent UX rot (see friendlyApiError's `captcha_provider_unavailable`
// history). One arm, one contract.

export type KnownChannelErrorCode =
  | "no_session"
  | "not_explicit"
  | "network_not_found"
  | "user_not_found"
  | "invalid_reason"
  | "invalid_channel"
  | "invalid_nick"
  | "invalid_mask"
  | "invalid_line"
  | "upstream_unavailable"
  | "body_too_large";

const KNOWN_CODES: ReadonlySet<KnownChannelErrorCode> = new Set<KnownChannelErrorCode>([
  "no_session",
  "not_explicit",
  "network_not_found",
  "user_not_found",
  "invalid_reason",
  "invalid_channel",
  "invalid_nick",
  "invalid_mask",
  "invalid_line",
  "upstream_unavailable",
  "body_too_large",
]);

function isKnownCode(code: string): code is KnownChannelErrorCode {
  return KNOWN_CODES.has(code as KnownChannelErrorCode);
}

export function friendlyChannelError(err: ChannelPushError): string {
  if (!isKnownCode(err.code)) return err.message;
  return friendlyKnown(err.code);
}

function friendlyKnown(code: KnownChannelErrorCode): string {
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
    default:
      // Exhaustiveness: adding a token to `KnownChannelErrorCode` without a
      // `case` arm narrows `code` to `never` only when every member is
      // handled, so this becomes a tsc compile error.
      return assertNever(code);
  }
}
