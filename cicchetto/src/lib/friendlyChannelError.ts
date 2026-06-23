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
// awaits — currently only `away` set/unset (socket.ts `pushAwaySet` /
// `pushAwayUnset`); the ops verbs are fire-and-forget and never reach this
// catch. Adding a token: add it to the union, add a `case`, ship the vitest
// arm. Tokens the server no longer emits (e.g. `visitor_no_away`) MUST NOT
// be mapped — a dead arm is silent UX rot (see friendlyApiError's
// `captcha_provider_unavailable` history). One arm, one contract.

export type KnownChannelErrorCode =
  | "no_session"
  | "not_explicit"
  | "network_not_found"
  | "user_not_found"
  | "invalid_reason";

const KNOWN_CODES: ReadonlySet<KnownChannelErrorCode> = new Set<KnownChannelErrorCode>([
  "no_session",
  "not_explicit",
  "network_not_found",
  "user_not_found",
  "invalid_reason",
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
    default:
      // Exhaustiveness: adding a token to `KnownChannelErrorCode` without a
      // `case` arm narrows `code` to `never` only when every member is
      // handled, so this becomes a tsc compile error.
      return assertNever(code);
  }
}
