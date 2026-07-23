import { type ApiError, assertNever } from "./api";

// U-3 (UD3): single closed-union typed-error → human copy module.
// Pre-U-3 the mapping lived only in `Login.tsx`'s local `friendlyMessage`;
// every other ApiError surface (ComposeBox, admin tabs, /connect via
// the compose box's slash-command path) leaked the raw wire token
// (`network_busy`, `too_many_sessions`, ...) into operator-visible
// alerts. Per `feedback_no_localized_strings_server_side` cic owns the
// human-readable copy for every typed error from the server.
//
// The match is on `err.code` only — the snake_case A7 envelope token
// emitted by FallbackController (see `lib/grappa_web/controllers/
// fallback_controller.ex` moduledoc). Adding a new server-side error
// arm means: pick the snake_case token, add it to `KnownApiErrorCode`
// below (the literal union), add a `case` in the switch, and ship
// the vitest matrix below.
//
// Cic M2 reviewer fix: `KnownApiErrorCode` is the literal-union of
// every wire token cic knows how to localize. The switch narrows
// `err.code` (a bare `string`) through `isKnownCode` and dispatches
// against the union — adding a token to the union without a `case`
// becomes a `tsc` failure via `assertNever`. Closed-union
// exhaustiveness, enforced at compile time, mirroring the server-side
// `@type capacity_error` discipline.
//
// The `default` arm at the bare-string level falls back to
// `err.message` — the ApiError's `<status> <code>` string — which is
// loud enough that an unmapped arm is operator-visible (no silent
// drop) while still being safer than leaking the wire token directly.
// Tests in `__tests__/friendlyApiError.test.ts` enumerate every known
// arm so a server-side rename surfaces here, not in a phantom UX bug.

export type KnownApiErrorCode =
  | "invalid_credentials"
  | "too_many_sessions"
  | "network_busy"
  | "network_unreachable"
  | "connect_timeout"
  | "welcome_timeout"
  | "probe_timeout"
  | "service_degraded"
  | "captcha_failed"
  | "captcha_required"
  | "malformed_ident"
  | "not_connected"
  | "upstream_unreachable"
  | "nick_in_use"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "internal"
  | "unauthorized"
  | "validation_failed"
  | "cannot_disconnect_self"
  | "rate_limited"
  | "not_raster"
  | "too_large"
  | "ssrf_blocked"
  | "fetch_failed"
  | "image_reencode_failed"
  | "too_many_attempts"
  | "list_full"
  | "session_timeout"
  | "invalid_message"
  | "already_attached"
  | "theme_cap_reached";

const KNOWN_CODES: ReadonlySet<KnownApiErrorCode> = new Set<KnownApiErrorCode>([
  "invalid_credentials",
  "too_many_sessions",
  "network_busy",
  "network_unreachable",
  "connect_timeout",
  "welcome_timeout",
  "probe_timeout",
  "service_degraded",
  "captcha_failed",
  "captcha_required",
  "malformed_ident",
  "not_connected",
  "upstream_unreachable",
  "nick_in_use",
  "forbidden",
  "not_found",
  "bad_request",
  "internal",
  "unauthorized",
  "validation_failed",
  "cannot_disconnect_self",
  "rate_limited",
  "not_raster",
  "too_large",
  "ssrf_blocked",
  "fetch_failed",
  "image_reencode_failed",
  "too_many_attempts",
  "list_full",
  "session_timeout",
  "invalid_message",
  "already_attached",
  "theme_cap_reached",
]);

function isKnownCode(code: string): code is KnownApiErrorCode {
  return KNOWN_CODES.has(code as KnownApiErrorCode);
}

export function friendlyApiError(err: ApiError): string {
  if (!isKnownCode(err.code)) return err.message;
  return friendlyKnown(err, err.code);
}

function friendlyKnown(err: ApiError, code: KnownApiErrorCode): string {
  switch (code) {
    case "invalid_credentials":
      return "Invalid name or password.";
    case "too_many_sessions":
      // U-3 (UD3): ip_cap_exceeded — this source IP already holds
      // its allotted session(s) for this network (`max_per_ip`,
      // default 1). The operator's recourse is to disconnect the
      // existing session on this device OR open from a different
      // device. Distinct from `network_busy`, which is a
      // network-wide capacity exhaustion (different operator action).
      return "You're already at the session limit for this network from this device. Disconnect first or open from a different device.";
    case "network_busy":
      return "This network is at capacity. Try again in a few minutes.";
    case "network_unreachable": {
      const retry = err.info.retry_after;
      return typeof retry === "number"
        ? `We can't reach the network right now. Retry in ${retry} seconds.`
        : "We can't reach the network right now.";
    }
    // U-2 (UD7): three typed timeout phases, mapped per-phase to actionable
    // operator copy. `connect_timeout` = TCP/TLS handshake didn't complete
    // within the inner budget (3s default) — likely transient routing
    // hiccup, retry fast. `welcome_timeout` = handshake succeeded but the
    // upstream's NICK/USER → 001 RPL_WELCOME chain stalled (Bahamut rDNS
    // is the canonical wild-world case) — upstream is slow/overloaded,
    // wait longer. `probe_timeout` = the outer budget tripped before the
    // inner ones; that's a server-side budget-arithmetic bug, not a
    // user-actionable failure.
    case "connect_timeout":
      return "Couldn't reach the network — handshake didn't complete. Retry in a few seconds.";
    case "welcome_timeout":
      return "The network is responding slowly. Wait a minute and try again.";
    case "probe_timeout":
      return "Login service had an internal timeout. Please try again — if it persists, contact your operator.";
    case "service_degraded":
      // Server-side captcha-verification outage OR any other server-side
      // dependency-degradation 503. Bucket G H1 history:
      // `captcha_provider_unavailable` arm shadowed this case at the
      // call sites that translated the server contract — but the server
      // never emits that literal wire token, so the dead arm gave silent
      // UX degradation. One arm, one contract.
      return "Login service temporarily unavailable. Please try again.";
    case "captcha_failed":
      return "Captcha challenge failed. Please try again.";
    case "captcha_required":
      // Reached only via the disabled-provider routing in Login's
      // handleError (operator demanded captcha but wired no provider)
      // — every other captcha_required path branches into the widget
      // mount.
      return "Verification temporarily unavailable.";
    case "malformed_ident":
      // #152 — login-Advanced / settings ident failed shape validation
      // (over 10 chars, illegal char, or a residual `~` after strip).
      return "Ident must be 1–10 characters: letters, digits, dot, dash, or underscore.";
    case "not_connected":
      // T32 — `/connect <network>` against a credential that's not in
      // `:parked` or `:failed` state, OR `/disconnect` against an
      // already-disconnected network. Compose-box-time error.
      return "That network isn't in a state to connect or disconnect right now.";
    case "upstream_unreachable":
      // M-9a — DNS / TCP-level reach failure for a network the operator
      // tried to /connect. Distinct from `network_unreachable`
      // (server-side circuit-breaker) — this is a per-request connect
      // failure, not a cooldown.
      return "Couldn't reach the upstream IRC server. Check the network is up.";
    case "nick_in_use":
      // #40 — 433 ERR_NICKNAMEINUSE during login registration (the chosen
      // nick is already on the upstream) OR a visitor `/nick` rename
      // colliding with another visitor row. Both surface the same 409
      // envelope; the copy is actionable: pick another nick.
      return "That nickname is already in use on this network. Pick another one.";
    case "forbidden":
      return "Your account isn't allowed to perform that action.";
    case "not_found":
      return "That network or resource doesn't exist.";
    case "bad_request":
      return "The request was malformed.";
    case "internal":
      return "The server hit an internal error. Please try again.";
    case "unauthorized":
      // Cic M3 reviewer fix: `Plugs.Authn` 401 envelope. In practice
      // `setOn401Handler` (api.ts) typically clears the bearer +
      // reroutes to /login before this arm runs, but any surface that
      // surfaces the ApiError directly (e.g. test/debug consoles, or
      // a future surface that opts out of the global handler) gets a
      // friendly message instead of a raw wire token.
      return "Your session expired. Please log in again.";
    case "validation_failed": {
      // Cic M3 reviewer fix: bucket-G-unified 422 envelope. The
      // server attaches per-field error arrays via the top-level
      // `field_errors` key (mirrored into `err.info.field_errors`
      // by `readError`). When present, render a compact "field:
      // msg" summary so the user sees WHICH field is wrong and
      // WHY without parsing wire tokens; falls back to a generic
      // copy when the shape is degraded.
      const fieldErrors = err.info.field_errors as Record<string, string[]> | undefined;
      if (fieldErrors !== undefined && fieldErrors !== null && typeof fieldErrors === "object") {
        const parts: string[] = [];
        for (const [field, msgs] of Object.entries(fieldErrors)) {
          if (Array.isArray(msgs) && msgs.length > 0) {
            parts.push(`${field}: ${msgs.join(", ")}`);
          }
        }
        if (parts.length > 0) return `Please fix: ${parts.join("; ")}.`;
      }
      return "The request was invalid. Please check your input.";
    }
    case "cannot_disconnect_self":
      // Cic M3 reviewer fix: 422 admin-self-action guard. Reached
      // when an admin tries to disconnect or terminate their own
      // live session via `/admin/sessions`. AdminSessionsTab
      // surfaces the verb separately via its raw-token error
      // banner (operator console policy — operators want the
      // wire token for debugging); this arm exists so any other
      // surface that bubbles the ApiError up gets friendly copy.
      return "You can't disconnect or terminate your own session.";
    case "rate_limited":
      // #75 themes — the server caps theme creation/publish per day per
      // user (anti-abuse, ~5/day). Reached on Save/publish once the daily
      // budget is spent; the recourse is to wait.
      return "You've hit today's theme limit. Try again tomorrow.";
    // #75 themes — background-image upload pipeline errors (POST
    // /themes/background). The server validates content-type (raster
    // only, no SVG), a size cap, re-encodes to strip polyglots, and
    // SSRF-guards the fetch-by-URL path.
    case "not_raster":
      return "That file isn't a supported image. Use a PNG, JPEG, GIF, or WebP.";
    case "too_large":
      return "That image is too large. Pick a smaller file.";
    case "ssrf_blocked":
      return "That URL isn't allowed. Use a public image URL, or upload a file instead.";
    case "fetch_failed":
      return "Couldn't fetch that image URL. Check the link, or upload a file instead.";
    case "image_reencode_failed":
      return "That image couldn't be processed. Try a different file.";
    case "too_many_attempts":
      // S6 (review 2026-07-19) — mode-1 login failure window tripped
      // for this source IP. Time-bounded (15 min), unlike the
      // themes-specific rate_limited "try tomorrow" copy.
      return "Too many login attempts. Wait a few minutes and try again.";
    case "list_full":
      // #247 (review 2026-07-19 R1) — the /notify watch list hit its
      // per-network cap (`Grappa.Notify.max_entries/0`). A bounded
      // resource, not a rate — the recourse is pruning, not waiting.
      return "Your watch list for this network is full. Remove an entry first.";
    // #364 bucket H (cross-surface S3) — four FallbackController tokens
    // whose server comments assert cic copy exists, but KnownApiErrorCode
    // had no arm, so they leaked the raw `<status> <code>` string into
    // operator-visible alerts.
    case "session_timeout":
      // REV-J M14 — 504 from any REST IRC-verb path (POST /messages, join,
      // part) when the Session.Server mailbox is blocked on a slow upstream
      // numeric. Retry-After: 10s; the recourse is a short retry.
      return "The network is taking too long to respond. Try again in a few seconds.";
    case "invalid_message":
      // 422 from `ReadCursor.set/4` — the message_id exists but doesn't
      // belong to this (subject, network, channel). Request shape was
      // valid; the referenced row is out of scope for the read cursor.
      return "Couldn't update your read position — that message isn't in this conversation.";
    case "already_attached":
      // #211 phase 4c — 409 from `POST /session/networks` accreting a
      // network the identity already holds a credential for. Not an error
      // the user must fix; the network is already there.
      return "You're already connected to that network.";
    case "theme_cap_reached":
      // #299 item 8 — 429 when a visitor hits the 50-total owned-theme cap.
      // The server comment promises "a cap-specific 'delete a theme to make
      // room' hint (vs 'try tomorrow')" — distinct from `rate_limited`.
      return "You've reached your theme limit. Delete a theme to make room.";
    default:
      // Cic M2 reviewer fix: exhaustiveness assertion. Adding a token
      // to `KnownApiErrorCode` without a `case` arm above becomes a
      // tsc compile error here (the function-arg `code` is narrowed
      // to `never` only when every union member has been handled).
      return assertNever(code);
  }
}
