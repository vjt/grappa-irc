defmodule GrappaWeb.ErrorTokens do
  @moduledoc """
  Single source of truth for the **wire-level error token space** — the
  `%{error: "<token>"}` envelope every REST action (via
  `GrappaWeb.FallbackController`, plus the `uploads`/`test-reset`
  surfaces) and every `GrappaChannel`/`AdminChannel` push reply speak
  (#369 D6a).

  ## Why this module exists

  Before D6a there was NO enumeration of the wire tokens: each emitter
  hard-coded its `error: "..."` string inline (56 REST + 21 channel
  tokens across five files), the `@spec` on `FallbackController.call/2`
  listed the INPUT atoms (not the wire strings — 11 of them bend, e.g.
  `:ip_cap_exceeded → "too_many_sessions"`), and the cicchetto client
  hand-maintained a parallel `KnownApiErrorCode` / `KnownChannelErrorCode`
  union that drifted (23 unmapped REST + 8 unmapped channel tokens; the
  `invalid_line` / `body_too_large` REST copies fell through to the raw
  wire string). The 2026-07-20 architecture review (#369 A6) measured
  the drift; this module is the enumeration that pins it.

  ## What the types mean

  Each `@type` member is the **wire string as an atom** — the string
  that actually appears in `error: "..."`, NOT the internal error atom
  the context returns. When `FallbackController` bends an input atom to
  a different wire string (`:no_session → "not_found"`,
  `:ip_cap_exceeded → "too_many_sessions"`, `{:start_failed, _} →
  "upstream_unreachable"`, …), the type lists the WIRE side.

  `t:shared_error_token/0` holds the tokens emitted on **both**
  transports (`not_found`, `forbidden`, `invalid_line`,
  `body_too_large`) — declared ONCE so a transport-shared token has a
  single definition (the root cause of the `invalid_line` /
  `body_too_large` REST-vs-channel fall-through was that no such shared
  declaration existed). `t:rest_error_token/0` and
  `t:channel_error_token/0` each union the shared set with their
  transport-specific tokens.

  Test-only surfaces are OUT of scope: `TestResetSubjectController` is
  compile-gated to `:dev`/`:test` ("module + route literally do not
  exist in the prod release") so its tokens are not part of the
  product's wire contract. The drift test skips `Mix.env()`-gated
  emitters accordingly.

  ## How it stays honest

  `test/grappa_web/error_tokens_drift_test.exs` DERIVES the emitted
  token set by AST-walking every `lib/grappa_web/**/*.ex` emitter
  (`json(%{error: "..."})` for REST, `{:error, %{error: "..."}}` for
  channel) and asserts it EQUALS these types. Derive-not-duplicate: a
  hand-kept second list would be exactly the parallel structure that
  drifts. Adding, removing, or renaming a wire token is a loud test
  failure until the type is updated in lockstep.

  ## Downstream (D6b, not yet wired)

  These `@type` declarations are the intended codegen source for
  `mix grappa.gen_wire_types`, which will emit the cicchetto client's
  `KnownApiErrorCode` / `KnownChannelErrorCode` as GENERATED literal
  unions so the client `assertNever` switches fail `tsc` on any
  server-side token change — closing the loop the entity wire types
  already have. That wiring (codegen glob-widen vs marker attribute,
  client curated-subset-vs-full-union) is deferred to D6b.
  """

  # Tokens emitted on BOTH transports (REST json envelope AND channel
  # push reply). Declared once so a shared token has ONE definition —
  # the missing shared declaration is why `invalid_line` /
  # `body_too_large` drifted across transports client-side.
  @type shared_error_token ::
          :not_found
          | :forbidden
          | :invalid_line
          | :body_too_large

  @typedoc """
  Wire tokens emitted by REST actions — `FallbackController` (the
  `action_fallback` target + the `Plugs.Authn` 401 delegate) and the
  `UploadsController` not-found path. Values are the snake_case wire
  strings per the A7 envelope convention.
  """
  @type rest_error_token ::
          shared_error_token
          | :bad_request
          | :unauthorized
          | :file_too_large
          | :metadata_strip_failed
          | :insufficient_storage
          | :unsupported_media_type
          | :invalid_setting
          | :addressing_unusable
          | :rate_limited
          | :too_many_attempts
          | :theme_cap_reached
          | :list_full
          | :not_raster
          | :too_large
          | :ssrf_blocked
          | :fetch_failed
          | :image_reencode_failed
          | :not_connected
          | :forbidden_vhost
          | :invalid_credentials
          | :invalid_two_factor
          | :two_factor_challenge_expired
          | :already_enabled
          | :too_many_sessions
          | :network_busy
          | :network_unreachable
          | :captcha_required
          | :captcha_failed
          | :service_degraded
          | :db_unavailable
          | :malformed_nick
          | :malformed_ident
          | :password_required
          | :password_mismatch
          | :network_not_visitor_enabled
          | :network_ambiguous
          | :network_unconfigured
          | :upstream_unreachable
          | :connect_timeout
          | :welcome_timeout
          | :session_timeout
          | :probe_timeout
          | :internal
          | :session_plan_resolve_failed
          | :invalid_message
          | :anon_collision
          | :nick_in_use
          | :cannot_disconnect_self
          | :source_not_local
          | :already_exists
          | :already_attached
          | :credentials_present
          | :scrollback_present
          | :last_admin
          | :share_token_expired
          | :share_token_consumed
          | :validation_failed

  @typedoc """
  Wire tokens emitted by channel push replies — `GrappaChannel`
  (`handle_in` / `join`) and `AdminChannel` (`join` catch-all). Values
  are the snake_case wire strings the cicchetto `friendlyChannelError`
  map consults.
  """
  @type channel_error_token ::
          shared_error_token
          | :unknown_topic
          | :invalid_payload
          | :user_not_found
          | :network_not_found
          | :no_session
          | :not_explicit
          | :invalid_nick
          | :not_cached
          | :lookup_failed
          | :open_failed
          | :close_failed
          | :unknown_event
          | :save_failed
          | :invalid_reason
          | :invalid_mask
          | :upstream_unavailable
          | :persist_failed
          | :invalid_channel
          | :links_in_flight
          | :nothing_to_recover
          | :already_identified
          | :recovery_in_progress
          | :rate_limited
end
