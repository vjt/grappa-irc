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
           | :timeout
           | :internal
           | :invalid_message
           | :nick_in_use
           | {:anon_collision, non_neg_integer()}
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
  #   * 429 — client misbehaviour (too many sessions from same client).
  #   * 503 — server-side capacity / upstream / dependency degradation.
  #   * 400 — captcha challenge required or failed (request was
  #     well-formed but lacks a valid solve).
  #
  # The `:network_circuit_open` clause matches ONLY the tuple shape;
  # `Admission.check_circuit/1` always emits the tuple, so a bare-atom
  # clause would be dead code that misleads future readers.
  def call(conn, {:error, :client_cap_exceeded}) do
    conn
    |> put_status(:too_many_requests)
    |> json(%{error: "too_many_sessions"})
  end

  def call(conn, {:error, :network_cap_exceeded}) do
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

  def call(conn, {:error, :timeout}) do
    conn
    |> put_status(:gateway_timeout)
    |> json(%{error: "timeout"})
  end

  def call(conn, {:error, :internal}) do
    conn
    |> put_status(:internal_server_error)
    |> json(%{error: "internal"})
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
