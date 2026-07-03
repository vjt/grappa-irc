defmodule GrappaWeb.FallbackController do
  @moduledoc """
  `action_fallback` target. Maps the **known** `{:error, _}` shapes
  returned by context functions to JSON HTTP responses so each action
  can stay on the happy path. Unknown error shapes intentionally raise
  `FunctionClauseError` and surface as a Phoenix 500 — adding a
  catch-all would hide context bugs that should be loud at boundary.

  ## Wire-string convention (A7)

  All atom-error responses use a single `%{error: "<token>"}` envelope
  whose value is the **snake_case stringification of the atom tag**:
  `:bad_request → "bad_request"`, `:not_found → "not_found"`, etc. The
  `Plugs.Authn` 401 body (`{"error":"unauthorized"}`) follows the same
  shape — clients parse the same envelope at every door. Adding a new
  tagged error means: pick a snake_case atom, add a clause here, and
  the wire string falls out automatically. Don't introduce a different
  envelope (`%{message: ...}`, `%{code: ...}`) for any sub-class —
  consistency at the wire is more valuable than per-error nuance.

  Validation errors (`%Ecto.Changeset{}`) use the SAME `error: "<token>"`
  envelope with `error: "validation_failed"`, AND attach the
  field-level error map as a top-level `field_errors` key alongside.
  Pre-bucket-G the changeset path emitted `%{errors: %{field =>
  [msg]}}` — no `error` discriminator, so cic's `readError` fell
  through to `body.errors.detail` (Phoenix default-error shape, NOT
  Ecto changeset shape) and from there to `res.statusText`. Every 422
  collapsed to "Unprocessable Entity" client-side, losing field-level
  info. The new shape mirrors how the captcha arm already attaches
  `site_key` + `provider` alongside `error: "captcha_required"`.

  Add a new clause whenever a context introduces a new tagged error
  (e.g. `{:error, :network_unknown}` in Task 5+) and update the spec
  in lockstep.
  """
  use GrappaWeb, :controller

  @spec call(
          Plug.Conn.t(),
          {:error,
           :bad_request
           | :forbidden
           | :not_found
           | :no_session
           | :not_connected
           | :invalid_credentials
           | :invalid_line
           | :unauthorized
           | :malformed_nick
           | :password_required
           | :password_mismatch
           | :upstream_unreachable
           | :connect_timeout
           | :welcome_timeout
           | :probe_timeout
           | :internal
           | :invalid_message
           | :nick_in_use
           | :cannot_disconnect_self
           | :insufficient_storage
           | :unsupported_media_type
           | :already_exists
           | :scrollback_present
           | :last_admin
           | :share_token_expired
           | :share_token_consumed
           | {:invalid_setting, String.t()}
           | {:file_too_large, pos_integer()}
           | {:metadata_strip, String.t()}
           | {:anon_collision, non_neg_integer()}
           | {:credentials_present, non_neg_integer()}
           | Grappa.Admission.error()
           | Ecto.Changeset.t()}
        ) :: Plug.Conn.t()
  def call(conn, {:error, :bad_request}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "bad_request"})
  end

  # `Plugs.Authn` runs upstream of every controller's `action_fallback`
  # so it can't lean on the implicit dispatch — but the 401 wire body
  # must match what this module produces, otherwise the snake_case
  # envelope splits across two emitters. M5: `Authn.unauthorized/1`
  # delegates here so the body bytes live in one place.
  def call(conn, {:error, :unauthorized}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "unauthorized"})
  end

  # CRLF / NUL byte in an IRC-bound field. Distinct from :bad_request
  # so client-side error handling can tell "you sent a malformed
  # request" apart from "your input would have smuggled an extra IRC
  # command onto the upstream wire."
  def call(conn, {:error, :invalid_line}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "invalid_line"})
  end

  # 413 body_too_large: GrappaWeb.BodyLimit boundary reject when a
  # POST body / channel-verb text field exceeds the configured byte
  # cap (no-silent-drops B6.9a HIGH-19). Pre-fix the payload reached
  # IRC.Client.transport_send and either truncated silently at the
  # 512-byte RFC framing limit or got the upstream peer to disconnect
  # — UI claimed `:ok` while the message never arrived. Surfacing as
  # 413 lets cic render an actionable rejection instead.
  def call(conn, {:error, :body_too_large}) do
    conn
    |> put_status(:request_entity_too_large)
    |> json(%{error: "body_too_large", limit: GrappaWeb.BodyLimit.max_body_bytes()})
  end

  # UX-6-B1: `POST /api/uploads` size policing — admin-configurable
  # per-category per-file cap read at request time from
  # `Grappa.ServerSettings.get_upload_per_file_cap_bytes/1`. Distinct
  # from `:body_too_large` (the JSON-payload cap on text endpoints)
  # because the cap value is dynamic, surfaced inline in the wire
  # body so cic can render the actionable threshold.
  def call(conn, {:error, {:file_too_large, max_bytes}}) when is_integer(max_bytes) do
    conn
    |> put_status(:request_entity_too_large)
    |> json(%{error: "file_too_large", max_bytes: max_bytes})
  end

  # Metadata-strip cluster (#39): the server-side EXIF/QuickTime
  # strip failed, so the upload is rejected — storing the original
  # would leak GPS + device identity, the boundary fails CLOSED.
  # 422: request shape valid, type allowed, file unprocessable. The
  # reason stays server-side (`MetadataStrip` logs it) — tool stderr
  # can leak tmp paths and tool internals, and cic's copy for this
  # case doesn't branch on it.
  def call(conn, {:error, {:metadata_strip, _}}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "metadata_strip_failed"})
  end

  # UX-6-B1: global-disk cap on the embedded uploader. Operator
  # tunes the ceiling via `Grappa.ServerSettings.put_upload_global_
  # cap_bytes/1`. 507 carries the dedicated semantics for "store is
  # at capacity" (RFC 4918, originally WebDAV but widely understood);
  # cic surfaces the same admin-action affordance as
  # `:network_busy` (talk to your admin).
  def call(conn, {:error, :insufficient_storage}) do
    conn
    |> put_status(:insufficient_storage)
    |> json(%{error: "insufficient_storage"})
  end

  # UX-6-B1: MIME rejected at the `POST /api/uploads` boundary.
  # Allowed list lives in `GrappaWeb.UploadsController.@allowed_mimes`
  # and mirrors the cic-side `embeddedHost.acceptedMimeTypes`. 415
  # signals "shape is valid, type unsupported" — cic gates the
  # picker `accept=` attribute on the same list so this 415 is
  # belt-and-braces against a bypass.
  def call(conn, {:error, :unsupported_media_type}) do
    conn
    |> put_status(:unsupported_media_type)
    |> json(%{error: "unsupported_media_type"})
  end

  # UX-6-B1: admin attempted `PUT /admin/settings` with an
  # out-of-shape value (non-positive cap, unknown active_host
  # string). Carries the offending field path for cic to highlight
  # in the AdminSettingsTab form.
  def call(conn, {:error, {:invalid_setting, field}}) when is_binary(field) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "invalid_setting", field: field})
  end

  def call(conn, {:error, :not_found}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not_found"})
  end

  # T32 (S1.3): `Networks.disconnect/2` rejects if the credential is
  # already `:parked` or `:failed` — the caller asked to disconnect a
  # network that isn't connected. 400 rather than 409 because the
  # transition is simply invalid given current state, and the client
  # should inspect the credential's `connection_state` before retrying.
  def call(conn, {:error, :not_connected}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "not_connected"})
  end

  # Subject is authenticated but the action is not available to its kind
  # (Task 30: visitor `POST /networks/:slug/nick`). Distinct from
  # `:unauthorized` (no/invalid bearer) — the bearer is fine, the verb
  # isn't allowed for this subject. Wire body distinguishes so the SPA
  # can render "this account can't do that" vs "log in again."
  def call(conn, {:error, :forbidden}) do
    conn
    |> put_status(:forbidden)
    |> json(%{error: "forbidden"})
  end

  # S14 oracle close: `:no_session` collapses to the same wire body as
  # `:not_found`. The internal tag is preserved so callers (Session
  # boundary, controllers) keep their typed return shape and operator
  # logs distinguish the two states; the wire bytes are uniform so a
  # probing user cannot tell "credential exists, session not running"
  # apart from "no credential" or "wrong slug." All three are
  # network-not-found from the wire's perspective.
  def call(conn, {:error, :no_session}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not_found"})
  end

  # Login failure — uniform shape regardless of which credential
  # half was wrong (mirrors `Accounts.get_user_by_credentials/2`'s
  # oracle posture). The 401 wire body matches `Plugs.Authn`'s
  # `{"error":"unauthorized"}` shape closely so client UX collapses
  # both authn failure paths to the same "drop credentials, send to
  # login" branch.
  def call(conn, {:error, :invalid_credentials}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "invalid_credentials"})
  end

  # T31 admission errors. Status-code split:
  #
  #   * 503 — server-side capacity / upstream / dependency degradation.
  #     Includes `:ip_cap_exceeded` (#171 — the per-(source-IP, network)
  #     slot is full) — semantically resource exhaustion, not rate limit.
  #     429 would imply "slow down" but the actor isn't spamming; their
  #     source IP already holds its allotted session(s) (`max_per_ip`,
  #     default 1) and one must disconnect first.
  #   * 400 — captcha challenge required or failed (request was
  #     well-formed but lacks a valid solve).
  #
  # The `:network_circuit_open` clause matches ONLY the tuple shape;
  # `Admission.check_circuit/1` always emits the tuple, so a bare-atom
  # clause would be dead code that misleads future readers.
  #
  # U-2 (UD3): per-network total cap is split into typed visitor / user
  # errors so admin dashboards + telemetry can tell capacity-bucket
  # apart. Both wire to the SAME `network_busy` 503 envelope — the cic
  # banner copy stays unified ("this network is at capacity") because
  # the operator-knob distinction is internal: visitor cap full does
  # NOT imply user cap full, and vice versa.
  #
  # The envelope split (`too_many_sessions` vs `network_busy`) preserves
  # the actor-scoped vs network-scoped distinction at the wire, so cic
  # renders different copy ("you're at the limit from THIS source" vs
  # "the network is full for everyone") per
  # `feedback_no_localized_strings_server_side`. cic keys on the wire
  # string, not the Elixir atom.
  def call(conn, {:error, :ip_cap_exceeded}) do
    conn
    |> put_status(:service_unavailable)
    |> json(%{error: "too_many_sessions"})
  end

  def call(conn, {:error, :visitor_cap_exceeded}) do
    conn
    |> put_status(:service_unavailable)
    |> json(%{error: "network_busy"})
  end

  def call(conn, {:error, :user_cap_exceeded}) do
    conn
    |> put_status(:service_unavailable)
    |> json(%{error: "network_busy"})
  end

  def call(conn, {:error, {:network_circuit_open, retry_after}})
      when is_integer(retry_after) do
    conn
    |> put_resp_header("retry-after", Integer.to_string(retry_after))
    |> put_status(:service_unavailable)
    |> json(%{error: "network_unreachable"})
  end

  def call(conn, {:error, :captcha_required}) do
    conn
    |> put_status(:bad_request)
    |> json(%{
      error: "captcha_required",
      site_key: captcha_site_key(),
      provider: captcha_provider_wire()
    })
  end

  def call(conn, {:error, :captcha_failed}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "captcha_failed"})
  end

  def call(conn, {:error, :captcha_provider_unavailable}) do
    conn
    |> put_status(:service_unavailable)
    |> json(%{error: "service_degraded"})
  end

  # L-web-1: AuthController error envelope migration. Visitor login
  # surface returns these atoms via `Visitors.Login.login/2`; routing
  # them through here keeps every action's success-vs-error envelope
  # in one place. Wire bodies match the prior controller-inline
  # `send_error` shapes so the migration is a pure refactor — no
  # client-visible change.
  def call(conn, {:error, :malformed_nick}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "malformed_nick"})
  end

  def call(conn, {:error, :password_required}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "password_required"})
  end

  def call(conn, {:error, :password_mismatch}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "password_mismatch"})
  end

  def call(conn, {:error, :upstream_unreachable}) do
    conn
    |> put_status(:bad_gateway)
    |> json(%{error: "upstream_unreachable"})
  end

  # U-2 (UD7): three-way split replaces pre-U-2 single `:timeout`.
  # Each carries distinct operator semantics + distinct Retry-After
  # hints — fast `:connect_timeout` retries are cheap, post-handshake
  # `:welcome_timeout` retries should back off further because the
  # upstream is likely overloaded or rDNS-blocked, and `:probe_timeout`
  # is an assertion path (outer guard fired before inner budgets — a
  # programming error in the budget arithmetic).
  def call(conn, {:error, :connect_timeout}) do
    conn
    |> put_resp_header("retry-after", "30")
    |> put_status(:service_unavailable)
    |> json(%{error: "connect_timeout"})
  end

  def call(conn, {:error, :welcome_timeout}) do
    conn
    |> put_resp_header("retry-after", "60")
    |> put_status(:service_unavailable)
    |> json(%{error: "welcome_timeout"})
  end

  # REV-J M14: post-call_session/3 consolidation, every REST IRC-verb
  # path can now surface `{:error, :timeout}` for an upstream-stuck
  # Session.Server (mailbox blocked on a slow upstream numeric, or a
  # 1s `Client.send_quit` synchronous call inside terminate/2). Pre-fix
  # call_session/3 raised on the implicit-5s timeout; the typed shape
  # is the consistent FallbackController contract.
  def call(conn, {:error, :timeout}) do
    conn
    |> put_resp_header("retry-after", "10")
    |> put_status(:gateway_timeout)
    |> json(%{error: "session_timeout"})
  end

  def call(conn, {:error, :probe_timeout}) do
    conn
    |> put_status(:internal_server_error)
    |> json(%{error: "probe_timeout"})
  end

  def call(conn, {:error, :internal}) do
    conn
    |> put_status(:internal_server_error)
    |> json(%{error: "internal"})
  end

  # U-0 — `PATCH /networks/:id { connection_state: "connected" }` returns
  # `:resolve_failed` when the cred's `SessionPlan.resolve/1` cannot
  # construct a plan (e.g. no servers bound on this network — a
  # config-time misbinding by the operator). 500-class because the
  # cause is server-state misconfiguration, not user input — operator
  # must fix the network's server bindings via `bin/grappa add-server`.
  def call(conn, {:error, :resolve_failed}) do
    conn
    |> put_status(:internal_server_error)
    |> json(%{error: "session_plan_resolve_failed"})
  end

  # U-0 — `Grappa.SpawnOrchestrator.spawn/4` wraps every non-admission
  # `DynamicSupervisor.start_child/2` failure as `{:start_failed,
  # term()}`. In the current codebase this is a SAFETY NET, not a
  # reachable production path: `Session.Server.init/1` is non-blocking
  # by design (TCP connect happens in `handle_continue`), so
  # `start_child` returns `{:ok, pid}` immediately and upstream
  # connect failures surface as runtime crash-loop, NOT as a wrapped
  # `:start_failed` at the controller. The clause exists so a future
  # change to a synchronous `init/1` probe doesn't silently 500 with
  # no JSON body. Mapped to 502 because the wrapped reason is almost
  # always upstream-side; the wrapped term is logged at the
  # orchestrator and NOT echoed over the wire (could leak transport-
  # layer details).
  def call(conn, {:error, {:start_failed, _}}) do
    conn
    |> put_status(:bad_gateway)
    |> json(%{error: "upstream_unreachable"})
  end

  # `Grappa.ReadCursor.set/4` returns this when the `message_id` exists
  # but doesn't belong to (subject, network, channel) — request shape
  # was valid; the data referenced a different scope. 422 is the right
  # surface for "well-formed but semantically rejected"; distinguished
  # from 400 (request shape bad) and 404 (resource missing entirely).
  def call(conn, {:error, :invalid_message}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "invalid_message"})
  end

  # 409 anon_collision: tuple shape mirrors `{:network_circuit_open,
  # retry_after}` — the Retry-After value is computed at the
  # controller boundary (it requires a Visitors lookup that the
  # FallbackController shouldn't own) and threaded through here so
  # the wire response shape stays in this module.
  def call(conn, {:error, {:anon_collision, retry_after}})
      when is_integer(retry_after) and retry_after >= 0 do
    conn
    |> put_resp_header("retry-after", Integer.to_string(retry_after))
    |> put_status(:conflict)
    |> json(%{error: "anon_collision"})
  end

  # 409 nick_in_use: V9 (visitor-parity cluster) — visitor `/nick` rename
  # collides with another visitor row on the same network. No
  # Retry-After: the holder may keep the nick indefinitely (NickServ-
  # identified visitors carry `expires_at = NULL`); the operator
  # should pick a different target. Distinct atom from
  # `{:anon_collision, _}` (login-time path) so cic can render
  # context-appropriate copy.
  def call(conn, {:error, :nick_in_use}) do
    conn
    |> put_status(:conflict)
    |> json(%{error: "nick_in_use"})
  end

  # M-cluster M-9a: admin attempted to disconnect / terminate their own
  # live session via `POST /admin/sessions/:id/disconnect` or
  # `DELETE /admin/sessions/:id`. Operator boundary rejects rather than
  # letting the admin lock themselves out — 422 because the request is
  # well-formed AND authorized, just semantically invalid.
  def call(conn, {:error, :cannot_disconnect_self}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "cannot_disconnect_self"})
  end

  # Admin-panel bucket 1 — strict-create REST surfaces. The
  # `:already_exists` atom collapses 409 Conflict for `POST /admin/networks`
  # (duplicate slug) and `POST /admin/networks/:nid/servers`
  # (duplicate `(host, port)` per network). Distinct from the changeset
  # `validation_failed` 422 path because the request shape was valid —
  # the conflict is with existing data.
  def call(conn, {:error, :already_exists}) do
    conn
    |> put_status(:conflict)
    |> json(%{error: "already_exists"})
  end

  # Admin-panel bucket 1 — `DELETE /admin/networks/:id` with bound
  # credentials. Threads `N = credential_count` through the tuple shape
  # (same encoding as `{:network_circuit_open, retry_after}`) so the
  # operator UI can render "you have 3 users on this network — unbind
  # them first" without a second roundtrip.
  def call(conn, {:error, {:credentials_present, n}}) when is_integer(n) and n >= 0 do
    conn
    |> put_status(:conflict)
    |> json(%{error: "credentials_present", credential_count: n})
  end

  # Admin-panel bucket 1 — `DELETE /admin/networks/:id` refuses when
  # archival scrollback would be orphaned (`Networks.delete_network/1`'s
  # :restrict-FK gate). Sole producer since GH #105 dropped the
  # `unbind_credential/2` cascade-on-empty that used to share this body.
  def call(conn, {:error, :scrollback_present}) do
    conn
    |> put_status(:conflict)
    |> json(%{error: "scrollback_present"})
  end

  # Admin-panel bucket 2 — `PUT /admin/users/:id` (demote) +
  # `DELETE /admin/users/:id` refuse when the target is the sole
  # admin (would lock the deployment out of its own admin panel).
  # 422 because the request is well-formed AND authorized; just
  # semantically invalid. Same wire shape as `:cannot_disconnect_self`.
  def call(conn, {:error, :last_admin}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "last_admin"})
  end

  # Visitor session-sharing consume — token signature valid but TTL
  # elapsed. 410 Gone signals "this resource (the share link) is
  # permanently unavailable" so cic UI renders "this link expired"
  # rather than a generic 401-style "log in again." Distinct atom from
  # `:share_token_consumed` (same status, different reason) so cic
  # copy + telemetry can split.
  def call(conn, {:error, :share_token_expired}) do
    conn
    |> put_status(:gone)
    |> json(%{error: "share_token_expired"})
  end

  # Visitor session-sharing consume — token signature valid + TTL OK
  # but the one-shot ETS ledger says it was already redeemed. 410 Gone
  # for the same reason as `:share_token_expired` — the link is
  # permanently unusable from this point forward.
  def call(conn, {:error, :share_token_consumed}) do
    conn
    |> put_status(:gone)
    |> json(%{error: "share_token_consumed"})
  end

  def call(conn, {:error, %Ecto.Changeset{} = changeset}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{error: "validation_failed", field_errors: format_changeset_errors(changeset)})
  end

  defp format_changeset_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {k, v}, acc ->
        String.replace(acc, "%{#{k}}", to_string(v))
      end)
    end)
  end

  # Boot-time captcha config — read once at app start by
  # `Grappa.Admission.Config.boot/0`, stored in `:persistent_term`,
  # snapshot is the source of truth for all readers (this controller +
  # Captcha.{Turnstile,HCaptcha}). CLAUDE.md "Application.get_env
  # runtime banned" — the boundary lives in `Grappa.Admission.Config`.
  defp captcha_site_key do
    Grappa.Admission.Config.config().captcha_site_key
  end

  defp captcha_provider_wire, do: Grappa.Admission.captcha_provider_wire()
end
