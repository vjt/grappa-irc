defmodule GrappaWeb.AuthController do
  @moduledoc """
  REST authentication endpoints.

    * `POST /auth/login` — `{identifier, password?}` →
      `{token, subject: {kind, id, ...}}`. Dispatched by
      `Grappa.Auth.IdentifierClassifier`:
      - `@` present → mode-1 admin → name-keyed lookup against the
        local-part via `Accounts.get_user_by_credentials/2` (password
        REQUIRED). Phase 5 hardening adds a real email column.
      - else → visitor path → `Grappa.Visitors.Login.login/2` (password
        OPTIONAL — required only for registered visitors).
    * `DELETE /auth/logout` — revokes the session bound to the bearer
      token via the `:authn` pipeline. Idempotent.

  Login records the requesting `ip` + `user-agent` on the session row
  for audit (`Accounts.create_session/4`). The IP is read from
  `conn.remote_ip` AFTER the `GrappaWeb.Plugs.RemoteIpFromProxy` plug
  (wired in `GrappaWeb.Endpoint`) has resolved X-Forwarded-For /
  X-Real-IP from the nginx reverse proxy — so the persisted IP is
  the real client, not the docker-bridge nginx IP.

  Visitor case-3 (anon collision token reuse, W13) consumes the inbound
  `Authorization: Bearer <uuid>` header to rotate the holder's token
  without preempting the live `Session.Server`. The header is extracted
  inline because `/auth/login` is NOT behind `:authn` (login is the
  surface that mints the token in the first place).

  `:current_client_id` is populated by `GrappaWeb.Plugs.ClientId`
  (wired into the `:api` pipeline so login + every authenticated route
  share one extraction site).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, Networks, Session, Visitors}
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Visitors.{Login, Visitor}
  alias GrappaWeb.RemoteIP

  require Logger

  @anon_retry_after_ceiling_seconds 48 * 3600

  # #211 phase 3 — the compile-time `:visitor_network` pin is GONE. The
  # visitor network is now resolved at request time from the runtime
  # `networks.visitor_enabled` allowlist (`Networks.list_visitor_enabled/0`
  # / the optional per-request `network` slug), admin-togglable without
  # a restart. The retry-after hint on `:anon_collision` resolves the
  # slug the same way (`collision_network_slug/1`). No
  # `Application.compile_env`/`get_env` read remains here.

  # M-web-3: cap captcha_token at 4096 bytes BEFORE forwarding to
  # Login.login/2 (which would forward to the upstream Turnstile /
  # HCaptcha verify endpoint). 4096 bytes is generous for any
  # legitimate provider token (Turnstile ~600B, HCaptcha ~1600B);
  # anything larger is abuse-shaped and should be rejected at the
  # boundary so the upstream HTTP client never sees it.
  @captcha_token_max_bytes 4096

  @doc """
  `POST /auth/login` — `{identifier, password?}` →
  `{token, subject: {kind, id, ...}}`.

  Validates the input shape at the boundary (identifier present + binary)
  and returns 400 otherwise. Dispatch is delegated to
  `IdentifierClassifier`; per-branch failures map to canonical HTTP
  statuses (see moduledoc + `visitor_login/3`).
  """
  @spec login(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error,
             :bad_request
             | :malformed_nick
             | :malformed_ident
             | :password_required
             | :password_mismatch
             | :network_not_visitor_enabled
             | :network_ambiguous
             | :network_unconfigured
             | :invalid_credentials
             | :upstream_unreachable
             | :connect_timeout
             | :welcome_timeout
             | :probe_timeout
             | :internal
             | {:anon_collision, non_neg_integer()}
             | Grappa.Admission.error()}
  def login(conn, %{"identifier" => id} = params) when is_binary(id) do
    password = Map.get(params, "password")
    captcha_token = Map.get(params, "captcha_token")
    # #152 — login-Advanced ident/realname (both optional). Passed raw;
    # the Visitor changeset sanitizes (tilde-strip) + shape-validates.
    identity = %{ident: Map.get(params, "ident"), realname: Map.get(params, "realname")}
    # #211 phase 3 — optional target network slug. Absent (today's cic)
    # → Login defaults to the sole `visitor_enabled` network.
    network = Map.get(params, "network")

    case validate_captcha_token(captcha_token) do
      :ok ->
        case IdentifierClassifier.classify(sanitize_identifier(id)) do
          {:email, email} -> mode1_login(conn, email, password)
          {:nick, nick} -> visitor_login(conn, nick, password, captcha_token, identity, network)
          {:error, :malformed} -> {:error, :malformed_nick}
        end

      :bad_token ->
        {:error, :bad_request}
    end
  end

  def login(_, _), do: {:error, :bad_request}

  # #138 — sanitize the login identifier at the HTTP boundary before
  # classification. Mobile Chrome/Android soft keyboards inject a
  # trailing space (or other surrounding whitespace / non-printable
  # control chars) via autocapitalize/autocorrect/autofill, which trips
  # the anchored nick regex in `Identifier.valid_nick?/1` → the login
  # 400s with `malformed_nick` BEFORE the password is ever checked, so a
  # legitimate visitor cannot log in from a phone.
  #
  # Two-step, order matters: strip C0 + DEL + C1 control chars
  # (`\x00-\x1F`, `\x7F`, `\x80-\x9F` — never valid in a nick or email,
  # and an interior control char would survive a bare trim) FIRST, then
  # `String.trim/1` the surrounding whitespace (Unicode-aware — also
  # eats the NBSP ` ` some keyboards emit). This is the single
  # boundary: it runs upstream of BOTH the email and nick branches and
  # upstream of `Login.validate_nick/1`'s second classify, and it keeps
  # `IdentifierClassifier` / `Identifier.valid_nick?` pure syntactic
  # predicates (they deliberately do NOT trim — see their tests), per
  # the CLAUDE.md "convert/sanitize at the boundary, not inside business
  # logic" rule.
  @control_chars ~r/[\x{0000}-\x{001F}\x{007F}-\x{009F}]/u
  @spec sanitize_identifier(String.t()) :: String.t()
  defp sanitize_identifier(id) do
    id
    |> String.replace(@control_chars, "")
    |> String.trim()
  end

  # M-web-3: captcha_token is operator-attacker-controlled wire input.
  # Reject non-binary (JSON `42`, `null`, lists, maps) and oversize
  # binaries at the boundary so neither `Login.login/2` nor the
  # downstream Turnstile/HCaptcha HTTP client ever sees abuse-shaped
  # payloads. nil is allowed — provider Disabled / unconfigured paths
  # carry no token.
  @spec validate_captcha_token(term()) :: :ok | :bad_token
  defp validate_captcha_token(nil), do: :ok

  defp validate_captcha_token(token)
       when is_binary(token) and byte_size(token) <= @captcha_token_max_bytes,
       do: :ok

  defp validate_captcha_token(_), do: :bad_token

  @doc """
  `DELETE /auth/logout` — **detach** (#126). Revokes the session whose
  token was just validated by `GrappaWeb.Plugs.Authn` and closes the
  live WebSocket, but leaves the server-side `Session.Server` + upstream
  IRC connection UP for a PERSISTENT identity (registered user OR
  NickServ-identified visitor). Detach is bouncer-style: the web client
  logs out, the bouncer stays online.

  The lone exception is the ANON visitor (`password_encrypted == nil`):
  it keeps the W11 co-terminus teardown — `Session.stop_session/3` +
  `Visitors.purge_if_anon/1` — because an anon row has no persistent
  identity to come back to, so its session + scrollback die with its
  last `accounts_sessions` row. (An ephemeral visitor's user-facing
  "quit" IS this path.) See `maybe_terminate_sessions/1`.

  Pre-#126 logout tore the `Session.Server` down for EVERY subject,
  which (a) broke detach by killing the upstream and (b) left the
  user's `connection_state` at `:connected` while the pid was gone — a
  DB-vs-live desync. Scoping the teardown to anon visitors fixes both.
  Tear-down-and-leave ("quit") for a persistent identity is composed by
  the client from separate verbs (park-all / `POST /session/disconnect`)
  followed by this detach. Returns 204 + empty body.

  Order matters on the anon branch: stop the Session.Server BEFORE
  revoking the `accounts_sessions` row so the GenServer's mailbox
  drains via `terminate/2` cleanly, and BEFORE purging the visitor row
  so an in-flight scrollback persist doesn't trip the
  `messages.visitor_id` FK.

  H2: After session revocation, broadcasts a `"disconnect"` event to
  the per-subject UserSocket id-topic
  (`user_socket:<name>` for users, `user_socket:visitor:<id>` for
  visitors — matches `GrappaWeb.UserSocket`'s `id/1` callback).
  Phoenix's socket transport process is subscribed to its id-topic at
  connect time; receiving `"disconnect"` triggers a
  `{:stop, {:shutdown, :disconnected}, _}` from the socket's `__info__`
  catch-all, terminating the live WebSocket. Without this, a logged-out
  browser would keep receiving PubSub pushes until it reconnects (and
  gets rejected at re-auth) — Bearer-as-connect-credential needs
  mid-flight enforcement, not just connect-time re-check. Broadcast is
  fire-and-forget — runs LAST so a PubSub hiccup can't block the
  server-side teardown; the `{:error, _}` return from
  `c:Phoenix.Endpoint.broadcast/3` (PubSub server unreachable) is logged
  and swallowed since the session row is already revoked, so the WS
  will be rejected on its next message anyway.
  """
  @spec logout(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def logout(conn, _) do
    subject = conn.assigns[:current_subject]
    :ok = maybe_terminate_sessions(subject)
    :ok = Accounts.revoke_session(conn.assigns.current_session_id)
    :ok = maybe_disconnect_socket(subject)
    send_resp(conn, :no_content, "")
  end

  # #126 — detach is the ABSENCE of teardown. `DELETE /auth/logout` for a
  # PERSISTENT identity (a registered user OR a NickServ-identified
  # visitor, `password_encrypted` non-nil) revokes the web session +
  # closes the socket but leaves the server-side `Session.Server` +
  # upstream IRC connection UP (bouncer-style). Only the ANON visitor
  # keeps the W11 co-terminus teardown (stop + purge): an anon row has no
  # persistent identity to come back to, so its session dies with its
  # last `accounts_sessions` row. This single scoping fixes BOTH #126
  # bugs — detach no longer tears the user's upstream down (bug #1), and
  # with no teardown there is no DB-vs-live `connection_state` desync
  # (bug #2). Tear-down-and-leave ("quit") is a SEPARATE verb composed by
  # the client: user = park-all networks + detach; registered visitor =
  # `POST /session/disconnect` + detach; ephemeral visitor = this very
  # anon branch (an ephemeral's "quit" IS detach — it stops + purges).
  @spec maybe_terminate_sessions(GrappaWeb.Subject.t() | nil) :: :ok
  defp maybe_terminate_sessions({:visitor, %Visitor{password_encrypted: nil} = visitor}) do
    :ok = stop_visitor_session(visitor)
    :ok = Visitors.purge_if_anon(visitor.id)
  end

  defp maybe_terminate_sessions(_), do: :ok

  # H2: close the live WS via the shared `UserSocket.disconnect_subject/1`
  # (broadcast + logged-swallow, reused by #157's account-delete path so
  # there is ONE socket-teardown code path). nil / unexpected subject
  # shapes no-op.
  @spec maybe_disconnect_socket(GrappaWeb.Subject.t() | nil) :: :ok
  defp maybe_disconnect_socket({:visitor, %Visitor{}} = subject),
    do: GrappaWeb.UserSocket.disconnect_subject(subject)

  defp maybe_disconnect_socket({:user, %Accounts.User{}} = subject),
    do: GrappaWeb.UserSocket.disconnect_subject(subject)

  defp maybe_disconnect_socket(_), do: :ok

  @spec stop_visitor_session(Visitor.t()) :: :ok
  defp stop_visitor_session(%Visitor{} = visitor) do
    case Networks.get_network_by_slug(visitor.network_slug) do
      {:ok, %Networks.Network{id: network_id}} ->
        :ok = Session.stop_session({:visitor, visitor.id}, network_id, "logged out")

      {:error, :not_found} ->
        Logger.warning("visitor logout but network not found",
          visitor_id: visitor.id,
          network: visitor.network_slug
        )

        :ok
    end
  end

  defp mode1_login(_, _, nil), do: {:error, :invalid_credentials}

  defp mode1_login(conn, email, password) when is_binary(password) do
    # Mode-1 today is name-keyed. Phase 5 hardening adds a real email
    # column; for now the dispatch routes by `@` presence but the lookup
    # uses the local-part as the user `name`.
    name = email |> String.split("@", parts: 2) |> List.first()

    with {:ok, user} <- Accounts.get_user_by_credentials(name, password) do
      {:ok, session} =
        Accounts.create_session(
          {:user, user.id},
          format_ip(conn),
          user_agent(conn),
          client_id: conn.assigns[:current_client_id]
        )

      conn
      |> put_status(:ok)
      |> render(:login, token: session.id, subject: {:user, user})
    end
  end

  # W3: `captcha_token` arrives as a 4th explicit param so the
  # already-validated value from `login/2` is the SINGLE source.
  # Pre-fix this function re-read `conn.params["captcha_token"]` (raw,
  # unvalidated wire) which short-circuited the validation if a future
  # entry-point bypassed the `login/2` shape — the validate_captcha_token
  # plug only fires once on the `login/2` call, so the captcha boundary
  # and the upstream verify call must both consume the same value.
  defp visitor_login(conn, nick, password, captcha_token, identity, network) do
    input = %{
      nick: nick,
      password: password,
      ident: identity.ident,
      realname: identity.realname,
      ip: format_ip(conn),
      user_agent: user_agent(conn),
      token: extract_bearer(conn),
      captcha_token: captcha_token,
      client_id: conn.assigns[:current_client_id],
      # #211 phase 3 — optional target network (nil = sole enabled).
      network: network
    }

    case Login.login(input, []) do
      {:ok, %{visitor: %Visitor{} = v, token: token}} ->
        conn
        |> put_status(:ok)
        |> render(:login, token: token, subject: {:visitor, v})

      {:error, reason} ->
        visitor_error_response(conn, nick, network, reason)
    end
  end

  # L-web-1: every visitor-error atom now flows through
  # `GrappaWeb.FallbackController` (wired globally via `use GrappaWeb,
  # :controller`). Returning `{:error, reason}` here dispatches the
  # canonical wire shapes — 400 malformed_nick / 401 password_*
  # / 503 too_many_sessions / 503 network_busy / 503 network_unreachable
  # + Retry-After / 400 captcha_required+site_key / 400 captcha_failed /
  # 503 service_degraded / 502 upstream_unreachable / 504 timeout /
  # 500 internal / 409 anon_collision+Retry-After. The matching clause
  # is spelled exactly so the inline action's contract stays auditable
  # without grepping the FallbackController.
  defp visitor_error_response(_, _, _, :malformed_nick),
    do: {:error, :malformed_nick}

  # #152 — login-Advanced ident failed shape validation.
  defp visitor_error_response(_, _, _, :malformed_ident),
    do: {:error, :malformed_ident}

  defp visitor_error_response(_, _, _, :password_required),
    do: {:error, :password_required}

  defp visitor_error_response(_, _, _, :password_mismatch),
    do: {:error, :password_mismatch}

  # #171: visitor login is the primary per-source-IP-capped flow (its
  # nil-client bypass was the whole reason the cap collapsed to source
  # IP). Spelled explicitly so it reaches FallbackController's 503
  # too_many_sessions envelope instead of the catch-all `:internal` 500
  # below.
  defp visitor_error_response(_, _, _, :ip_cap_exceeded),
    do: {:error, :ip_cap_exceeded}

  defp visitor_error_response(_, _, _, :visitor_cap_exceeded),
    do: {:error, :visitor_cap_exceeded}

  defp visitor_error_response(_, _, _, :user_cap_exceeded),
    do: {:error, :user_cap_exceeded}

  defp visitor_error_response(_, _, _, {:network_circuit_open, _} = err),
    do: {:error, err}

  defp visitor_error_response(_, _, _, :captcha_required),
    do: {:error, :captcha_required}

  defp visitor_error_response(_, _, _, :captcha_failed),
    do: {:error, :captcha_failed}

  defp visitor_error_response(_, _, _, :captcha_provider_unavailable),
    do: {:error, :captcha_provider_unavailable}

  defp visitor_error_response(_, nick, network, :anon_collision),
    do: {:error, {:anon_collision, anon_collision_retry_after(nick, network)}}

  defp visitor_error_response(_, _, _, :upstream_unreachable),
    do: {:error, :upstream_unreachable}

  # #40: 433 ERR_NICKNAMEINUSE during registration. Surfaced as the
  # 409 nick_in_use envelope (FallbackController) so cic renders
  # "pick another nick" instead of the generic handshake-failed copy.
  defp visitor_error_response(_, _, _, :nick_in_use),
    do: {:error, :nick_in_use}

  defp visitor_error_response(_, _, _, :connect_timeout),
    do: {:error, :connect_timeout}

  defp visitor_error_response(_, _, _, :welcome_timeout),
    do: {:error, :welcome_timeout}

  defp visitor_error_response(_, _, _, :probe_timeout),
    do: {:error, :probe_timeout}

  # #211 phase 3 — the visitor picked a network that isn't in the runtime
  # `visitor_enabled` allowlist. FallbackController maps to 403 (see its
  # `:network_not_visitor_enabled` clause); distinct from
  # `:network_unconfigured` (no such / no enabled network) so cic can
  # tell "not allowed here" from "misconfigured".
  defp visitor_error_response(_, _, _, :network_not_visitor_enabled),
    do: {:error, :network_not_visitor_enabled}

  # #211 phase 3 — more than one network is visitor_enabled but the
  # request named none. Can't happen from today's cic (single enabled
  # network); the phase-6 picker sends a slug. 400 via FallbackController.
  defp visitor_error_response(_, _, _, :network_ambiguous),
    do: {:error, :network_ambiguous}

  defp visitor_error_response(_, _, _, _),
    do: {:error, :internal}

  # L-web-1: Retry-After value computed at the controller boundary —
  # the FallbackController shouldn't query Visitors directly. Threaded
  # to the FallbackController via the `{:anon_collision, retry_after}`
  # tuple shape mirroring `{:network_circuit_open, retry_after}`.
  #
  # #211 phase 3 — the target network slug is resolved from the request's
  # optional `network` param (falling back to the sole `visitor_enabled`
  # network) via the SAME runtime allowlist readers `Login` uses, rather
  # than the retired compile-time `:visitor_network` constant. If the
  # slug can't be resolved (ambiguous / none enabled) the collision hint
  # falls back to the ceiling — the collision itself already surfaced.
  @spec anon_collision_retry_after(String.t(), String.t() | nil) :: non_neg_integer()
  defp anon_collision_retry_after(nick, network) do
    with {:ok, slug} <- collision_network_slug(network),
         %Visitor{expires_at: expires_at} <-
           Visitors.get_by_nick_and_network(nick, slug) do
      expires_at
      |> DateTime.diff(DateTime.utc_now())
      |> max(1)
      |> min(@anon_retry_after_ceiling_seconds)
    else
      _ -> @anon_retry_after_ceiling_seconds
    end
  end

  @spec collision_network_slug(String.t() | nil) :: {:ok, String.t()} | :error
  defp collision_network_slug(slug) when is_binary(slug) and slug != "", do: {:ok, slug}

  defp collision_network_slug(_) do
    case Networks.list_visitor_enabled() do
      [%Networks.Network{slug: slug}] -> {:ok, slug}
      _ -> :error
    end
  end

  defp extract_bearer(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> token
      _ -> nil
    end
  end

  # Delegates to `GrappaWeb.RemoteIP.format/1` so the IPv4-mapped IPv6
  # unwrap (L-web-2) lands once for every controller that audits the
  # client IP.
  @spec format_ip(Plug.Conn.t()) :: String.t() | nil
  defp format_ip(conn), do: RemoteIP.format(conn)

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      [] -> nil
    end
  end
end
