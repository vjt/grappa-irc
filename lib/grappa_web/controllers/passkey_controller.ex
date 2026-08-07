defmodule GrappaWeb.PasskeyController do
  @moduledoc "Passkey settings plus passwordless and second-factor assertion endpoints."
  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias Grappa.Accounts.{User, WebAuthn}
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.RateLimit.FailureWindow
  alias GrappaWeb.{LoginThrottle, PasskeyOrigin, RemoteIP}

  @recovery_salt "account-passwordless-recovery-v1"
  @recovery_max_age_seconds 600

  # Recovery is throttled on TWO buckets, because one is sidesteppable.
  # The per-account bucket is the real control, but it can only be keyed
  # once the identifier RESOLVES — and resolution is itself the work an
  # attacker wants to amplify. So the IP bucket is checked first (cheap
  # ETS, no DB) and bounds probing for accounts that do not exist; the
  # account bucket then bounds guesses against one that does.
  @recovery_window_ms :timer.minutes(15)
  @recovery_ip_attempts 30
  @recovery_account_attempts 10

  # Ceremony allocation, not guessing: see `login_options/2`.
  @login_options_attempts 30

  @doc "Lists passkeys and active login mode."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def index(%{assigns: %{current_subject: {:user, user}}} = conn, _) do
    passkeys = Enum.map(WebAuthn.list(user), &public_passkey/1)
    json(conn, %{mode: user.passkey_mode, passkeys: passkeys})
  end

  def index(_, _), do: {:error, :forbidden}

  @doc "Starts registration after password confirmation."
  @spec registration_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def registration_options(
        %{assigns: %{current_subject: {:user, user}}} = conn,
        %{"password" => password, "name" => name}
      ) do
    with {:ok, options} <-
           WebAuthn.begin_registration(user, password, name, client_binding(conn), PasskeyOrigin.origin()) do
      json(conn, options)
    end
  end

  def registration_options(_, _), do: {:error, :bad_request}

  @doc "Completes passkey registration."
  @spec register(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def register(%{assigns: %{current_subject: {:user, user}}} = conn, params) do
    case WebAuthn.complete_registration(user, params, client_binding(conn)) do
      {:ok, passkey} -> conn |> put_status(:created) |> json(public_passkey(passkey))
      # #768 — a saturated writer is not a bad authenticator. Without this the
      # BusyRetry wrap around the insert would only downgrade the 500 into a
      # LIE, telling the user their brand-new credential was rejected.
      {:error, :db_unavailable} = err -> err
      _ -> {:error, :invalid_two_factor}
    end
  end

  def register(_, _), do: {:error, :bad_request}

  @doc "Starts mode-change assertion after password confirmation."
  @spec mode_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def mode_options(
        %{assigns: %{current_subject: {:user, user}}} = conn,
        %{"password" => password, "mode" => wire_mode}
      ) do
    with {:ok, mode} <- settings_mode(wire_mode),
         :ok <- Accounts.verify_password(user, password),
         {:ok, options} <- mode_change_options(conn, user, %{mode: mode}) do
      json(conn, options)
    end
  end

  def mode_options(_, _), do: {:error, :bad_request}

  # Passwordless is deliberately not settable here. It may only be reached
  # through `passwordless_options/2`, whose recovery token proves the codes
  # were shown BEFORE arming the mode that makes them the only fallback.
  defp settings_mode(wire_mode) do
    case WebAuthn.decode_mode(wire_mode) do
      {:ok, mode} when mode in [:second_factor, :disabled] -> {:ok, mode}
      _ -> {:error, :bad_request}
    end
  end

  defp mode_change_options(conn, user, metadata),
    do: WebAuthn.begin_authentication(user, :mode_change, client_binding(conn), PasskeyOrigin.origin(), metadata)

  @doc "Generates the mandatory recovery set before passwordless activation."
  @spec prepare_passwordless(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def prepare_passwordless(
        %{assigns: %{current_subject: {:user, user}, current_session_id: session_id}} = conn,
        %{"password" => password}
      ) do
    with :ok <- Accounts.verify_password(user, password) do
      codes = Accounts.prepare_recovery_codes()

      # ENCRYPTED, not merely signed: this payload carries the plaintext
      # recovery codes, and a signed token is tamper-proof but perfectly
      # readable — anything the token passes through on its way back to us
      # could lift the account's whole fallback credential out of it.
      token =
        Phoenix.Token.encrypt(GrappaWeb.Endpoint, @recovery_salt, %{
          user_id: user.id,
          session_id: session_id,
          binding: client_binding(conn),
          codes: codes
        })

      json(conn, %{recovery_codes: codes, recovery_token: token})
    end
  end

  def prepare_passwordless(_, _), do: {:error, :bad_request}

  @doc "Starts passwordless activation only after recovery codes were shown."
  @spec passwordless_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def passwordless_options(
        %{assigns: %{current_subject: {:user, user}, current_session_id: session_id}} = conn,
        %{"recovery_token" => token}
      ) do
    binding = client_binding(conn)

    with {:ok, %{user_id: user_id, session_id: ^session_id, binding: ^binding, codes: codes}} <-
           verify_recovery_token(token),
         true <- user_id == user.id,
         {:ok, options} <- mode_change_options(conn, user, %{mode: :passwordless, recovery_codes: codes}) do
      json(conn, options)
    else
      _ -> {:error, :invalid_two_factor}
    end
  end

  def passwordless_options(_, _), do: {:error, :bad_request}

  @doc "Verifies mode-change assertion and applies the selected mode."
  @spec set_mode(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def set_mode(
        %{assigns: %{current_subject: {:user, current}, current_session_id: session_id}} = conn,
        params
      ) do
    with {:ok, %User{id: user_id} = user, %{mode: mode} = metadata} <-
           WebAuthn.authenticate(params, :mode_change, client_binding(conn)),
         true <- user_id == current.id,
         {:ok, ^mode} <- WebAuthn.set_mode(user, mode, session_id, Map.get(metadata, :recovery_codes, [])) do
      json(conn, %{mode: mode})
    else
      # #768 — `set_mode/4` rides out contention through `Repo.BusyRetry`, so
      # `:db_unavailable` is a legitimate outcome here. Collapsing it into the
      # oracle told the user their authenticator was wrong and sent them to
      # retry a ceremony that could not succeed; the honest answer is the 503
      # FallbackController already maps. Everything BELOW stays opaque on
      # purpose — this is an authentication oracle, not a diagnostic surface.
      {:error, :db_unavailable} = err -> err
      _ -> {:error, :invalid_two_factor}
    end
  end

  def set_mode(_, _), do: {:error, :bad_request}

  @doc "Deletes a passkey after password confirmation."
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def delete(
        %{assigns: %{current_subject: {:user, user}}} = conn,
        %{"id" => id, "password" => password}
      ) do
    with :ok <- Accounts.verify_password(user, password),
         :ok <- WebAuthn.delete(user, id) do
      send_resp(conn, :no_content, "")
    end
  end

  def delete(_, _), do: {:error, :bad_request}

  @doc """
  Starts passwordless login for an account identifier.

  IP-throttled: every call allocates a challenge in
  `WebAuthnChallengeStore` that only a completed ceremony reclaims, so an
  unauthenticated caller that never completes one must not be able to
  allocate without bound. The store's own sweep is the second half of
  that guarantee.
  """
  @spec login_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def login_options(conn, %{"identifier" => identifier}) when is_binary(identifier) do
    ip = RemoteIP.format(conn)

    case FailureWindow.check(:passkey_login_options, ip, @login_options_attempts) do
      {:error, :limited} ->
        {:error, :too_many_attempts}

      :ok ->
        # EVERY call is counted, not just the ones that fail. The abuse
        # here is allocation, and the cheapest way to allocate is to keep
        # succeeding: a loop against a known passwordless identifier gets
        # a 200 each time, so a failures-only window would never trip on
        # the exact traffic it needs to bound. So the crossing charge —
        # and the operator signal it raises — lands on a request that
        # SUCCEEDS.
        _ =
          LoginThrottle.charge(
            :passkey_login_options,
            ip,
            @recovery_window_ms,
            @login_options_attempts
          )

        begin_passwordless(conn, identifier)
    end
  end

  def login_options(_, _), do: {:error, :bad_request}

  defp begin_passwordless(conn, identifier) do
    with %User{passkey_mode: :passwordless} = user <- find_user(identifier),
         {:ok, options} <-
           WebAuthn.begin_authentication(user, :passwordless, client_binding(conn), PasskeyOrigin.origin(), %{}) do
      json(conn, options)
    else
      _ -> {:error, :invalid_credentials}
    end
  end

  @doc "Verifies passwordless assertion and mints a bearer."
  @spec login_verify(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def login_verify(conn, params) do
    case WebAuthn.authenticate(params, :passwordless, client_binding(conn)) do
      {:ok, %User{passkey_mode: :passwordless} = user, _} -> mint_session(conn, user)
      # #815 — `authenticate/3` writes the sign counter, so a saturated writer
      # is a legitimate outcome of a VERIFIED assertion. The catch-all below is
      # the login oracle and stays opaque; a 503 is not part of it.
      {:error, :db_unavailable} = err -> err
      _ -> {:error, :invalid_two_factor}
    end
  end

  @doc "Verifies a post-password passkey assertion and mints a bearer."
  @spec second_factor_verify(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def second_factor_verify(conn, params) do
    case WebAuthn.authenticate(params, :second_factor, client_binding(conn)) do
      {:ok, %User{passkey_mode: :second_factor} = user, _} -> mint_session(conn, user)
      # #815 — as `login_verify/2`. Two actions, two `case`s: fixing one and
      # not the other leaves the second door telling the same lie.
      {:error, :db_unavailable} = err -> err
      _ -> {:error, :invalid_two_factor}
    end
  end

  @doc "Consumes an account recovery code for passwordless fallback."
  @spec recover(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def recover(conn, %{"identifier" => identifier, "recovery_code" => code}) do
    ip = RemoteIP.format(conn)

    case FailureWindow.check(:passkey_recovery, ip, @recovery_ip_attempts) do
      {:error, :limited} -> {:error, :too_many_attempts}
      :ok -> recover_resolved(conn, ip, find_user(identifier), code)
    end
  end

  def recover(_, _), do: {:error, :bad_request}

  # Keyed on the RESOLVED account, never on the wire identifier. `find_user/1`
  # folds an email to its local part, so `alice`, `alice@a.aa` and
  # `alice@b.bb` are one account — spelled as three distinct strings. Keying
  # the window on the string handed the attacker a fresh bucket per spelling
  # and the per-account limit never tripped.
  defp recover_resolved(conn, ip, %User{passkey_mode: :passwordless} = user, code) do
    key = {ip, user.id}

    with :ok <- FailureWindow.check(:passkey_recovery, key, @recovery_account_attempts),
         :ok <- Accounts.consume_recovery_code(user, code) do
      :ok = FailureWindow.clear(:passkey_recovery, key)
      mint_session(conn, user)
    else
      {:error, :limited} ->
        {:error, :too_many_attempts}

      _ ->
        _ = LoginThrottle.charge(:passkey_recovery, key, @recovery_window_ms, @recovery_account_attempts)
        _ = LoginThrottle.charge(:passkey_recovery, ip, @recovery_window_ms, @recovery_ip_attempts)
        {:error, :invalid_two_factor}
    end
  end

  # An identifier that resolves to no passwordless account charges the
  # ceiling and nothing else — there is no account to key the fine row on.
  defp recover_resolved(_, ip, _, _) do
    _ = LoginThrottle.charge(:passkey_recovery, ip, @recovery_window_ms, @recovery_ip_attempts)
    {:error, :invalid_two_factor}
  end

  defp mint_session(conn, user) do
    user_agent = conn |> get_req_header("user-agent") |> List.first()

    with {:ok, session} <-
           Accounts.create_session(
             {:user, user.id},
             RemoteIP.format(conn),
             user_agent,
             client_id: conn.assigns[:current_client_id]
           ) do
      conn |> put_status(:ok) |> json(GrappaWeb.AuthJSON.login(%{token: session.id, subject: {:user, user}}))
    end
  end

  defp find_user(identifier) do
    case IdentifierClassifier.classify(String.trim(identifier)) do
      {:email, email} -> email |> String.split("@", parts: 2) |> hd() |> Accounts.get_user_by_name()
      {:nick, name} -> Accounts.get_user_by_name(name)
      _ -> nil
    end
  end

  defp client_binding(conn),
    do: %{ip: RemoteIP.format(conn), client_id: conn.assigns[:current_client_id]}

  defp verify_recovery_token(token) do
    Phoenix.Token.decrypt(GrappaWeb.Endpoint, @recovery_salt, token, max_age: @recovery_max_age_seconds)
  end

  defp public_passkey(passkey) do
    %{id: passkey.id, name: passkey.name, inserted_at: passkey.inserted_at, last_used_at: passkey.last_used_at}
  end
end
