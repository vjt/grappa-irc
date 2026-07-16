import { ApiError, ChannelPushError } from "./api";
import { friendlyApiError } from "./friendlyApiError";
import { friendlyChannelError } from "./friendlyChannelError";

// #74 — the single dispatcher that turns a thrown error from EITHER send
// door into operator-visible human copy:
//   * REST `ApiError`        → `friendlyApiError`   (login/connect/topic set)
//   * WS   `ChannelPushError`→ `friendlyChannelError` (away / ops / topic clear)
//   * anything else          → a loud generic "send failed"
//
// Extracted from compose.ts's submit catch (which duplicated this exact
// two-branch map inline) so the inline-topic-edit submit in TopicBar reuses
// the identical mapping — one contract, no copy-paste-with-tweaks
// (CLAUDE.md: implement once, reuse everywhere). cic owns the human copy for
// every typed server error (`feedback_no_localized_strings_server_side`).

/**
 * Map a thrown value from a send door to human copy. Typed errors route to
 * their per-surface friendly map; an untyped throw falls back to a generic —
 * loud, never silent — "send failed".
 */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) return friendlyApiError(e);
  if (e instanceof ChannelPushError) return friendlyChannelError(e);
  return "send failed";
}
