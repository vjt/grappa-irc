defmodule GrappaWeb.PasskeyController do
  @moduledoc "Passkey settings plus passwordless and second-factor assertion endpoints."
  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias Grappa.Accounts.{User, WebAuthn}
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.RateLimit.FailureWindow
  alias GrappaWeb.RemoteIP

  @recovery_salt "account-passwordless-recovery-v1"
  @recovery_max_age_seconds 600

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
           WebAuthn.begin_registration(user, password, name, client_binding(conn), origin()) do
      json(conn, options)
    end
  end

  def registration_options(_, _), do: {:error, :bad_request}

  @doc "Completes passkey registration."
  @spec register(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def register(%{assigns: %{current_subject: {:user, user}}} = conn, params) do
    case WebAuthn.complete_registration(user, params, client_binding(conn)) do
      {:ok, passkey} -> conn |> put_status(:created) |> json(public_passkey(passkey))
      _ -> {:error, :invalid_two_factor}
    end
  end

  def register(_, _), do: {:error, :bad_request}

  @doc "Starts mode-change assertion after password confirmation."
  @spec mode_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def mode_options(
        %{assigns: %{current_subject: {:user, user}}} = conn,
        %{"password" => password, "mode" => mode}
      )
      when mode == "second_factor" do
    if Argon2.verify_pass(password, user.password_hash) do
      with {:ok, options} <-
             WebAuthn.begin_authentication(user, :mode_change, client_binding(conn), origin(), %{mode: mode}) do
        json(conn, options)
      end
    else
      {:error, :invalid_credentials}
    end
  end

  def mode_options(_, _), do: {:error, :bad_request}

  @doc "Generates the mandatory recovery set before passwordless activation."
  @spec prepare_passwordless(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def prepare_passwordless(
        %{assigns: %{current_subject: {:user, user}, current_session_id: session_id}} = conn,
        %{"password" => password}
      ) do
    if Argon2.verify_pass(password, user.password_hash) do
      codes = Accounts.prepare_recovery_codes()

      token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @recovery_salt, %{
          user_id: user.id,
          session_id: session_id,
          binding: client_binding(conn),
          codes: codes
        })

      json(conn, %{recovery_codes: codes, recovery_token: token})
    else
      {:error, :invalid_credentials}
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
         {:ok, options} <-
           WebAuthn.begin_authentication(user, :mode_change, client_binding(conn), origin(), %{
             mode: "passwordless",
             recovery_codes: codes
           }) do
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
    cond do
      not Argon2.verify_pass(password, user.password_hash) ->
        {:error, :invalid_credentials}

      user.passkey_mode != "disabled" and length(WebAuthn.list(user)) == 1 ->
        {:error, :passkey_required}

      true ->
        with :ok <- WebAuthn.delete(user, id), do: send_resp(conn, :no_content, "")
    end
  end

  def delete(_, _), do: {:error, :bad_request}

  @doc "Starts passwordless login for an account identifier."
  @spec login_options(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def login_options(conn, %{"identifier" => identifier}) do
    with %User{passkey_mode: "passwordless"} = user <- find_user(identifier),
         {:ok, options} <-
           WebAuthn.begin_authentication(user, :passwordless, client_binding(conn), origin()) do
      json(conn, options)
    else
      _ -> {:error, :invalid_credentials}
    end
  end

  def login_options(_, _), do: {:error, :bad_request}

  @doc "Verifies passwordless assertion and mints a bearer."
  @spec login_verify(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def login_verify(conn, params) do
    case WebAuthn.authenticate(params, :passwordless, client_binding(conn)) do
      {:ok, %User{passkey_mode: "passwordless"} = user, _} -> mint_session(conn, user)
      _ -> {:error, :invalid_two_factor}
    end
  end

  @doc "Verifies a post-password passkey assertion and mints a bearer."
  @spec second_factor_verify(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def second_factor_verify(conn, params) do
    case WebAuthn.authenticate(params, :second_factor, client_binding(conn)) do
      {:ok, %User{passkey_mode: "second_factor"} = user, _} -> mint_session(conn, user)
      _ -> {:error, :invalid_two_factor}
    end
  end

  @doc "Consumes an account recovery code for passwordless fallback."
  @spec recover(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def recover(conn, %{"identifier" => identifier, "recovery_code" => code}) do
    key = {RemoteIP.format(conn), String.downcase(String.trim(identifier))}

    with :ok <- FailureWindow.check(:passkey_recovery, key, 10),
         %User{passkey_mode: "passwordless"} = user <- find_user(identifier),
         :ok <- Accounts.consume_recovery_code(user, code) do
      :ok = FailureWindow.clear(:passkey_recovery, key)
      mint_session(conn, user)
    else
      {:error, :limited} ->
        {:error, :too_many_attempts}

      _ ->
        _ = FailureWindow.record_failure(:passkey_recovery, key, :timer.minutes(15))
        {:error, :invalid_two_factor}
    end
  end

  def recover(_, _), do: {:error, :bad_request}

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

  defp origin, do: Application.get_env(:grappa, :passkey_origin, GrappaWeb.Endpoint.url())

  defp verify_recovery_token(token) do
    Phoenix.Token.verify(GrappaWeb.Endpoint, @recovery_salt, token, max_age: @recovery_max_age_seconds)
  end

  defp public_passkey(passkey) do
    %{id: passkey.id, name: passkey.name, inserted_at: passkey.inserted_at, last_used_at: passkey.last_used_at}
  end
end
