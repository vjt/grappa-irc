import { type ApiError, assertNever } from "./api";
import { formatBytes } from "./formatBytes";
import { ERROR_TOKENS_REST_ERROR_TOKEN, type ErrorTokensRestErrorToken } from "./wireTypes";

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
// fallback_controller.ex` moduledoc).
//
// #411 D6b — the union AND the runtime narrowing Set are GENERATED, not
// hand-listed. `ErrorTokensRestErrorToken` + `ERROR_TOKENS_REST_ERROR_TOKEN`
// come from `mix grappa.gen_wire_types` reading
// `GrappaWeb.ErrorTokens.rest_error_token` — the server's authoritative REST
// wire-token set. This DELIBERATELY OVERTURNS the pre-#411 "curated subset +
// noisy fallback" design this comment used to defend: there is no longer a
// hand-picked subset of tokens "cic knows how to localize." The union is the
// FULL server contract, so the ONLY hand-maintained structure left is the
// switch below (the copy — which is product). Adding a server-side error now
// means: the codegen widens the union, `assertNever` in the `default` arm
// turns it into a `tsc` failure until you add a `case`, and you ship the
// vitest matrix row. Three parallel structures (union + Set + switch)
// collapsed to one generated source + one hand-written switch — no
// half-migration. Ruling: "ogni cazzo di errore deve avere un copy" (#411).
//
// The `!isKnownCode` fallback to `err.message` (the ApiError's
// `<status> <code>` string) is NO LONGER the designed home for un-localized
// tokens — there are none (full exhaustiveness). It is now a DRIFT guard: it
// fires only if the server emits a token newer than the last codegen run (the
// generated union is stale) or an off-contract string, and stays loud so that
// drift is operator-visible rather than silently swallowed. Tests in
// `__tests__/friendlyApiError.test.ts` enumerate every arm so a server-side
// rename surfaces here, not in a phantom UX bug.

// The generated `ERROR_TOKENS_REST_ERROR_TOKEN` array is the single source
// for both the compile-time union (via `wireTypes`) and this runtime
// narrowing Set — no second hand-kept list to drift.
const KNOWN_CODES: ReadonlySet<ErrorTokensRestErrorToken> = new Set(ERROR_TOKENS_REST_ERROR_TOKEN);

function isKnownCode(code: string): code is ErrorTokensRestErrorToken {
  return KNOWN_CODES.has(code as ErrorTokensRestErrorToken);
}

export function friendlyApiError(err: ApiError): string {
  if (!isKnownCode(err.code)) return err.message;
  return friendlyKnown(err, err.code);
}

function friendlyKnown(err: ApiError, code: ErrorTokensRestErrorToken): string {
  switch (code) {
    case "invalid_credentials":
      return "Invalid name or password.";
    case "invalid_two_factor":
      return "Invalid or already-used authenticator/recovery code.";
    case "two_factor_challenge_expired":
      return "Two-factor challenge expired. Enter your password again.";
    case "already_enabled":
      return "Two-factor authentication is already enabled.";
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
    case "db_unavailable":
      // #523 / #518 — a web-reachable write exhausted its BusyRetry budget
      // against a transient SQLITE_BUSY (single-writer contention), so the
      // FallbackController surfaces a typed 503 (retry-after 1) instead of an
      // opaque 500 raise. Very short-lived; the client just retries.
      return "The service is momentarily busy. Please try again.";
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

    // ── #411 D6b — the 23 previously-unmapped REST tokens (product copy,
    //    vetted by vjt). Grouped by surface, same actionable-copy contract.

    // Upload pipeline. `file_too_large` carries `max_bytes` on the wire;
    // render it in human units (`formatBytes`) so the copy names the real cap,
    // with a graceful fallback to the capless (vetted) copy when the field is
    // absent or garbage — mirrors `credentials_present` / `anon_collision`.
    // The guard is finite-and-positive (not a bare `typeof`): a NaN/0 cap is
    // not a real limit, so it falls back rather than render "0 bytes".
    //
    // This is the GENERAL typed-error surface (a #411 drift-guard arm). Live
    // file uploads render their own 413 via `uploadOrchestrator`'s
    // `httpUploadMessage`, which now spells the cap via this SAME `formatBytes`
    // (#411 follow-up), so the two surfaces agree at every magnitude — an
    // admin-set 512 KB cap reads "512 KB" on both, not "0.5 MB" on one. The
    // orchestrator's `mbLabel` survives only for the fixed-unit "X of Y"
    // upload-progress line.
    case "file_too_large": {
      const max = err.info.max_bytes;
      return typeof max === "number" && Number.isFinite(max) && max > 0
        ? `That file is too large. The most you can upload is ${formatBytes(max)}. Choose a smaller one.`
        : "That file is too large. Choose a smaller one.";
    }
    case "metadata_strip_failed":
      // #39 — EXIF/QuickTime metadata strip failed; the upload is rejected
      // fail-CLOSED (storing the original would leak GPS + device identity).
      return "We couldn't strip that file's metadata, so it wasn't uploaded. Try a different file.";
    case "insufficient_storage":
      // UX-6-B1 — 507, the embedded uploader's global disk cap is full.
      // Operator-action affordance, like `network_busy`.
      return "Storage is full right now. Ask your operator to free up space.";
    case "unsupported_media_type":
      // UX-6-B1 — 415 MIME gate on `POST /api/uploads`. Distinct from
      // `not_raster` (the theme-background raster gate).
      return "That file type isn't supported.";
    case "invalid_setting":
      // UX-6-B1 — 422 admin `PUT /admin/settings` with an out-of-shape
      // value. Carries the offending `field` (AdminSettingsTab highlights it).
      return "That setting value isn't valid. Check it and try again.";
    case "addressing_unusable": {
      // #609 — `PUT /admin/settings` tried to switch to addressing mode 2
      // (static mapping) but the capability probe (SourceAliasManager.arm/1)
      // refused to arm the prefix on THIS host, so the mode was NOT stored
      // (422, no state change — fallback_controller.ex). The wire `reason`
      // (captured into err.info by readError) names WHY. `no_static_prefix`
      // is the one operator-actionable case — mode 2 chosen with no prefix
      // set; every other reason is a substrate-capability refusal
      // (substrate_disabled, ip_nonlocal_bind_disabled, anyip_route_missing,
      // alias_not_permitted, wrapper_unavailable, …) so we surface it
      // verbatim rather than maintain a brittle per-atom copy table — the
      // operator wants the concrete probe reason to diagnose the host, not a
      // generic toast.
      const reason = err.info.reason;
      if (reason === "no_static_prefix") {
        return "Set a static-mapping prefix before switching to mode 2 (static mapping).";
      }
      return typeof reason === "string" && reason.length > 0
        ? `Mode 2 (static mapping) can't be enabled on this server: ${reason}.`
        : "Mode 2 (static mapping) can't be enabled on this server.";
    }
    case "forbidden_vhost":
      // #228 — a vhost selection outside the subject's allowed set (403).
      return "That vhost isn't available to your account.";
    case "source_not_local":
      // #266 — admin set a per-network `source_address` the host can't
      // bind/egress from (422). Distinct from `validation_failed` (bad IP shape).
      return "That isn't an address this server can send from.";
    case "already_exists":
      // Admin bucket 1 — 409 duplicate slug (`POST /admin/networks`) or
      // duplicate (host, port) (`POST /admin/networks/:id/servers`).
      return "That already exists.";
    case "scrollback_present":
      // Admin bucket 1 — 409, `DELETE /admin/networks/:id` refuses when
      // archival scrollback would be orphaned.
      return "This network still has saved history. Clear it before deleting the network.";
    case "last_admin":
      // Admin bucket 2 — 422, demote/delete refused for the sole admin
      // (would lock the deployment out of its own admin panel).
      return "You can't remove the last admin.";
    case "credentials_present": {
      // Admin bucket 1 — 409, `DELETE /admin/networks/:id` with bound
      // credentials. `credential_count` is threaded through the wire so the
      // operator sees how many users to unbind first.
      const n = err.info.credential_count;
      return typeof n === "number"
        ? `This network still has ${n} connected user(s). Disconnect them before deleting it.`
        : "This network still has connected users. Disconnect them before deleting it.";
    }
    case "malformed_nick":
      // L-web-1 / #40 — login nick failed `Identifier.valid_nick?/1` shape.
      // Charset from `@nick_regex`: letters, digits, `- _ [ ] { } | \ \` ^`,
      // ≤ 30 chars, not starting with a digit.
      return "That nickname isn't valid. Use up to 30 letters, digits, or - _ [ ] { } | \\ ` ^, and don't start with a digit.";
    case "password_required":
      // 401 — the login/network requires a password and none was supplied.
      return "This network requires a password.";
    case "password_mismatch":
      // 401 — the supplied password was wrong (distinct from
      // `invalid_credentials`, the name-or-password oracle).
      return "That password is incorrect.";
    case "network_not_visitor_enabled":
      // #211 phase 3 — 403, the network exists but is not in the visitor
      // allowlist (admin has not opted it in).
      return "This network isn't open to guests.";
    case "network_ambiguous":
      // #211 phase 3 — 400, more than one visitor network is enabled but
      // the login named none. The picker must choose one.
      return "Please choose which network to connect to.";
    case "network_unconfigured":
      // #211 phase 3 — 503, no network is configured/enabled for guests.
      // #472 — this is a PERMANENT configuration state (an operator must opt a
      // network in), not a transient outage; the copy says so plainly. The old
      // "right now" wording read as a temporary blip that would clear itself.
      return "Visitor access is disabled on this server.";
    case "session_plan_resolve_failed":
      // U-0 — 500, the credential has no servers bound (operator misconfig);
      // `SessionPlan.resolve/1` can't build a plan.
      return "This network isn't fully set up. Ask your operator to check its server settings.";
    case "anon_collision": {
      // 409 — a visitor's chosen name is taken at login time. Carries
      // `retry_after`; interpolate it like `network_unreachable`, with a
      // graceful fallback when absent.
      const retry = err.info.retry_after;
      return typeof retry === "number"
        ? `That name is taken right now. Try again in ${retry} seconds.`
        : "That name is taken right now. Try again shortly.";
    }
    case "share_token_expired":
      // 410 Gone — the visitor share link's TTL elapsed.
      return "This share link has expired.";
    case "share_token_consumed":
      // 410 Gone — the visitor share link was already redeemed (one-shot).
      return "This share link has already been used.";
    case "invalid_line":
      // Shared token, REST side — CRLF/NUL in an IRC-bound field (400).
      // Mirrors the channel-side copy for the same token.
      return "That contains characters that aren't allowed.";
    case "body_too_large":
      // Shared token, REST side — text payload over the byte cap (413).
      // The wire carries `limit`; plain copy (no formatter needed).
      return "That message is too long to send.";

    default:
      // Cic M2 reviewer fix: exhaustiveness assertion. Adding a token
      // to the generated union without a `case` arm above becomes a
      // tsc compile error here (the function-arg `code` is narrowed
      // to `never` only when every union member has been handled).
      return assertNever(code);
  }
}
