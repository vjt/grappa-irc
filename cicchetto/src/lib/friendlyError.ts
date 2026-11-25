import { ApiError, ChannelPushError } from "./api";
import { friendlyApiError } from "./friendlyApiError";
import { friendlyChannelError, SEND_THROTTLED_COPY } from "./friendlyChannelError";
import { NoReply, NotConnected } from "./transportFailure";

// #74 — the single dispatcher that turns a thrown error from EITHER send
// door into operator-visible human copy:
//   * REST `ApiError`        → `friendlyApiError`   (login/connect/topic set)
//   * WS   `ChannelPushError`→ `friendlyChannelError` (away / ops / topic clear)
//   * `NoReply`              → no answer by the deadline (issue 2738)
//   * `NotConnected`         → known not sent (issue 2738)
//   * anything else          → a loud generic "send failed"
//
// Extracted from compose.ts's submit catch (which duplicated this exact
// two-branch map inline) so the inline-topic-edit submit in TopicBar reuses
// the identical mapping — one contract, no copy-paste-with-tweaks
// (CLAUDE.md: implement once, reuse everywhere). cic owns the human copy for
// every typed server error (`feedback_no_localized_strings_server_side`).

// #342 — throttle copy for the send door. The ingress token-bucket (#340)
// rejects a flooding send at the hard cap with HTTP 429 carrying the wire
// token `rate_limited` — the SAME token themes' per-day creation quota uses.
// On the send door that token means "slow down", NOT themes' "try tomorrow",
// so this dispatcher overrides it before delegating (see `friendlyError`).
// The themes surfaces (ThemeEditor/ThemeGallery) call `friendlyApiError`
// DIRECTLY, bypassing this dispatcher, so their `rate_limited` copy is
// untouched — the two surfaces are cleanly separated at the dispatcher, not
// papered over. Any `rate_limited` reaching `friendlyError` is a send
// throttle by construction. (The clean-slate contract would be a distinct
// server token à la `too_many_attempts`/`theme_cap_reached`; #340 shipped
// reusing `rate_limited` and #342 is scoped client-only, so the send door
// discriminates by surface here.)
//
// #630 — `SEND_THROTTLED_COPY` now lives in `friendlyChannelError.ts` (its
// `rate_limited` channel arm shares the exact same copy) and is imported
// above, so the REST and WS throttle surfaces speak with one voice.

/**
 * Map a thrown value from a send door to human copy. Typed errors route to
 * their per-surface friendly map; an untyped throw falls back to a generic —
 * loud, never silent — "send failed".
 */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "rate_limited") return SEND_THROTTLED_COPY;
    return friendlyApiError(e);
  }
  if (e instanceof ChannelPushError) return friendlyChannelError(e);
  // issue 2738 — NoReply is an UNKNOWN outcome, so the copy must not call it
  // a failure: the line may have gone out, and the composer hands it back
  // (vjt's D2) for the operator to judge, after any echo has had its chance.
  if (e instanceof NoReply) return "No answer from the server — it may still have gone through.";
  if (e instanceof NotConnected) {
    return "Not connected — wait for the connection to come back, then try again.";
  }
  return "send failed";
}
