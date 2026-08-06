import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { friendlyApiError, operatorApiError } from "../lib/friendlyApiError";

// U-3 (UD3) — exhaustive matrix over the typed-error wire tokens
// the server emits via FallbackController. Adding a new arm to
// friendlyApiError MUST add a matrix entry here so silent-drops
// (unmapped arm in production code, but no test = no canary)
// can't happen. Per `feedback_no_localized_strings_server_side` +
// the `project_no_silent_drops_closed` exhaustiveness lesson.
//
// We assert a SUBSTRING (not full equality) so copy tweaks don't
// require N test edits — the matrix's contract is "the code has
// a human-readable arm that includes a recognisable phrase," not
// the exact wording.

const CASES: Array<{ code: string; matches: RegExp; info?: Record<string, unknown> }> = [
  { code: "invalid_credentials", matches: /invalid name or password/i },
  // U-3: ip_cap_exceeded → device-scoped copy
  { code: "too_many_sessions", matches: /at the session limit for this network from this device/i },
  // visitor_cap_exceeded / user_cap_exceeded both wire to network_busy
  { code: "network_busy", matches: /this network is at capacity/i },
  // network_circuit_open carries retry_after
  {
    code: "network_unreachable",
    matches: /retry in 42 seconds/i,
    info: { retry_after: 42 },
  },
  { code: "network_unreachable", matches: /can't reach the network right now/i },
  { code: "connect_timeout", matches: /handshake didn't complete/i },
  { code: "welcome_timeout", matches: /responding slowly/i },
  { code: "probe_timeout", matches: /internal timeout/i },
  { code: "service_degraded", matches: /temporarily unavailable/i },
  { code: "captcha_failed", matches: /captcha challenge failed/i },
  { code: "captcha_required", matches: /verification temporarily unavailable/i },
  // T32 connect/disconnect compose-time errors (U-3 newly mapped)
  { code: "not_connected", matches: /isn't in a state to connect or disconnect/i },
  { code: "upstream_unreachable", matches: /couldn't reach the upstream irc server/i },
  // #40 — 433 nick-in-use at login, and visitor /nick rename collision
  { code: "nick_in_use", matches: /already in use on this network/i },
  { code: "forbidden", matches: /isn't allowed to perform that action/i },
  { code: "not_found", matches: /that network or resource doesn't exist/i },
  { code: "bad_request", matches: /the request was malformed/i },
  { code: "internal", matches: /server hit an internal error/i },
  // Cic M3 reviewer fix: previously-unmapped FallbackController arms.
  { code: "unauthorized", matches: /your session expired/i },
  {
    code: "validation_failed",
    matches: /please fix: nick: can't be blank/i,
    info: { field_errors: { nick: ["can't be blank"] } },
  },
  {
    code: "validation_failed",
    matches: /please fix: nick: too short, must be unique/i,
    info: { field_errors: { nick: ["too short", "must be unique"] } },
  },
  // validation_failed without info → generic copy fallback.
  { code: "validation_failed", matches: /the request was invalid/i },
  { code: "cannot_disconnect_self", matches: /can't disconnect or terminate your own session/i },
  // #75 themes — daily create/publish cap.
  { code: "rate_limited", matches: /today's theme limit/i },
  // #75 themes — background-image upload pipeline errors.
  { code: "not_raster", matches: /supported image/i },
  // Phrase unique to this arm — `file_too_large` also contains "too large".
  { code: "too_large", matches: /image is too large/i },
  { code: "ssrf_blocked", matches: /url isn't allowed/i },
  { code: "fetch_failed", matches: /couldn't fetch that image url/i },
  { code: "image_reencode_failed", matches: /couldn't be processed/i },
  // S6 (review 2026-07-19) — mode-1 login throttle.
  { code: "too_many_attempts", matches: /too many login attempts/i },
  // #247 (review 2026-07-19 R1) — /notify watch-list cap.
  { code: "list_full", matches: /watch list.*is full/i },
  // #364 bucket H (cross-surface S3) — FallbackController tokens that
  // reached operator-visible alerts as raw `<status> <code>` because
  // KnownApiErrorCode had no arm, despite the server comments promising
  // cic copy.
  // 504 — REST IRC-verb path hit an upstream-stuck Session.Server.
  { code: "session_timeout", matches: /taking too long to respond/i },
  // 422 — ReadCursor.set referenced a message outside (subject, network,
  // channel) scope.
  { code: "invalid_message", matches: /read position|this conversation/i },
  // 409 — visitor accretion of a network the identity already holds.
  { code: "already_attached", matches: /already connected/i },
  // 429 — visitor hit the 50-total owned-theme cap (distinct from the
  // daily rate_limited "try tomorrow" copy).
  { code: "theme_cap_reached", matches: /theme limit.*make room|make room/i },
  // #411 D6b — the 23 previously-unmapped REST tokens. The client union is
  // now the FULL `GrappaWeb.ErrorTokens.rest_error_token` set (generated),
  // so `assertNever` forces an arm for every one — these matrix rows are the
  // behavioural canary that the arm renders human copy, not a raw wire token.
  // Product copy, vetted by vjt (issue #411 comment).
  // Upload pipeline (#39 metadata, UX-6-B1 caps/MIME).
  // file_too_large carries max_bytes; interpolated (human size) + fallback.
  {
    code: "file_too_large",
    matches: /most you can upload is 5 MB/i,
    info: { max_bytes: 5 * 1024 * 1024 },
  },
  { code: "file_too_large", matches: /file is too large/i },
  { code: "metadata_strip_failed", matches: /metadata.*wasn't uploaded|couldn't strip/i },
  { code: "insufficient_storage", matches: /storage is full/i },
  { code: "unsupported_media_type", matches: /file type isn't supported/i },
  // Admin settings / vhost / admin-guard tokens.
  { code: "invalid_setting", matches: /setting value isn't valid/i },
  // #609 — mode-2 (static mapping) refused at set time; the wire `reason`
  // drives the copy. `no_static_prefix` is the operator-actionable branch;
  // any other reason is a substrate-capability refusal, surfaced verbatim.
  {
    code: "addressing_unusable",
    matches: /static-mapping prefix before switching to mode 2/i,
    info: { reason: "no_static_prefix" },
  },
  {
    code: "addressing_unusable",
    matches: /can't be enabled on this server: substrate_disabled/i,
    info: { reason: "substrate_disabled" },
  },
  { code: "forbidden_vhost", matches: /vhost isn't available/i },
  { code: "source_not_local", matches: /address this server can send from/i },
  { code: "already_exists", matches: /already exists/i },
  { code: "scrollback_present", matches: /saved history/i },
  { code: "last_admin", matches: /remove the last admin/i },
  // credentials_present carries credential_count; interpolated + fallback.
  {
    code: "credentials_present",
    matches: /3 connected user/i,
    info: { credential_count: 3 },
  },
  { code: "credentials_present", matches: /still has.*connected user/i },
  // Login / registration tokens (#152 ident, #211 visitor networks, #40 nick).
  { code: "malformed_nick", matches: /nickname isn't valid/i },
  // #152 — pre-existing arm; distinct ident-specific copy (adjacent to
  // malformed_nick, so a copy/paste swap must be caught by a dedicated row).
  { code: "malformed_ident", matches: /ident must be 1.10 characters/i },
  { code: "password_required", matches: /requires a password/i },
  { code: "password_mismatch", matches: /password is incorrect/i },
  { code: "network_not_visitor_enabled", matches: /isn't open to guests/i },
  { code: "network_ambiguous", matches: /choose which network/i },
  // #472 — permanent-config wording ("disabled on this server"), not the old
  // transient-sounding "right now" copy.
  { code: "network_unconfigured", matches: /visitor access is disabled on this server/i },
  { code: "session_plan_resolve_failed", matches: /isn't fully set up|server settings/i },
  // anon_collision carries retry_after; interpolated + fallback.
  { code: "anon_collision", matches: /try again in 30 seconds/i, info: { retry_after: 30 } },
  { code: "anon_collision", matches: /taken right now/i },
  // Visitor share-link consume (410 Gone).
  { code: "share_token_expired", matches: /link has expired/i },
  { code: "share_token_consumed", matches: /already been used/i },
  // Shared transport tokens, REST side (channel side already mapped).
  { code: "invalid_line", matches: /characters that aren't allowed/i },
  { code: "body_too_large", matches: /too long to send/i },
  // #523 / #518 — a web-reachable write's typed 503 when SQLITE_BUSY exhausts
  // the BusyRetry budget (FallbackController :db_unavailable, retry-after 1).
  { code: "db_unavailable", matches: /service is momentarily busy/i },
  // #696 — 409 refusing to delete the LAST passkey while passkey sign-in is
  // still enabled (`PasskeyController.delete/2`). The copy has to name the
  // two ways out, because the refusal is otherwise a dead end for the user.
  { code: "passkey_required", matches: /only passkey/i },
  // 409 asking for a ceremony with nothing registered to answer it — the
  // mirror of the above, and the door that used to answer 500.
  { code: "passkey_not_configured", matches: /don't have a passkey yet/i },
];

describe("friendlyApiError", () => {
  for (const { code, matches, info } of CASES) {
    it(`maps ${code}${info !== undefined ? " (with info)" : ""} to human copy`, () => {
      const err = new ApiError(500, code, info ?? {});
      expect(friendlyApiError(err)).toMatch(matches);
    });
  }

  it("falls through to ApiError.message for unknown wire tokens", () => {
    // S47 strict-equality regression — substring containment must NOT
    // collide with the closed-union arms. Defaulting to err.message
    // (`<status> <code>`) is loud enough that an unmapped arm is
    // operator-visible (no silent drop).
    const err = new ApiError(500, "some_unmapped_token");
    expect(friendlyApiError(err)).toBe("500 some_unmapped_token");
  });

  it("network_unreachable without retry_after info uses generic copy", () => {
    const err = new ApiError(503, "network_unreachable", {});
    expect(friendlyApiError(err)).toBe("We can't reach the network right now.");
  });
});

// #943 — the admin consoles render the raw wire token by policy, so they
// take this door instead of `friendlyApiError`. Its whole contract is the
// degradation ladder: detail when the 422 carries it, the bare token when it
// doesn't, the caller's fallback when there is no wire token at all.
describe("operatorApiError", () => {
  it("appends the per-field detail to the wire token", () => {
    const err = new ApiError(422, "validation_failed", {
      field_errors: { name: ["must start with a letter"], password: ["is too short"] },
    });
    expect(operatorApiError(err, "unused")).toBe(
      "validation_failed — name: must start with a letter; password: is too short",
    );
  });

  it("joins multiple messages for one field", () => {
    const err = new ApiError(422, "validation_failed", {
      field_errors: { name: ["is too short", "has invalid format"] },
    });
    expect(operatorApiError(err, "unused")).toBe(
      "validation_failed — name: is too short, has invalid format",
    );
  });

  for (const [label, info] of [
    ["absent", {}],
    ["null", { field_errors: null }],
    ["not an object", { field_errors: "name is bad" }],
    ["empty", { field_errors: {} }],
    ["all-empty arrays", { field_errors: { name: [] } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`degrades to the bare token when field_errors is ${label}`, () => {
      expect(operatorApiError(new ApiError(422, "validation_failed", info), "unused")).toBe(
        "validation_failed",
      );
    });
  }

  it("returns the caller's fallback for a non-ApiError throw", () => {
    expect(operatorApiError(new Error("net down"), "create_failed")).toBe("create_failed");
    expect(operatorApiError("boom", "request_failed")).toBe("request_failed");
  });
});
