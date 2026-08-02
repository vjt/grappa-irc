defmodule GrappaWeb.TotpController do
  @moduledoc "Authenticated TOTP enrollment, status, and disable endpoints."
  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias Grappa.Accounts.TOTP

  @enrollment_salt "account-totp-enrollment-v1"
  @enrollment_max_age_seconds 600

  @doc "Returns TOTP enrollment status without exposing secret material."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden}
  def show(%{assigns: %{current_subject: {:user, user}}} = conn, _) do
    json(conn, %{enabled: TOTP.enabled?(user)})
  end

  def show(_, _), do: {:error, :forbidden}

  @doc "Starts enrollment; returned secret remains unarmed until confirmation."
  @spec start_enrollment(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def start_enrollment(%{assigns: %{current_subject: {:user, user}}} = conn, _) do
    if TOTP.enabled?(user) do
      {:error, :already_enabled}
    else
      issuer = "Grappa (#{conn.host})"
      enrollment = TOTP.new_enrollment(user, issuer)

      token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @enrollment_salt, %{
          "user_id" => user.id,
          "secret" => enrollment.secret
        })

      json(conn, %{
        enrollment_token: token,
        secret: enrollment.secret,
        provisioning_uri: enrollment.provisioning_uri
      })
    end
  end

  def start_enrollment(_, _), do: {:error, :forbidden}

  @doc "Confirms enrollment, revokes other sessions, and returns recovery codes once."
  @spec confirm_enrollment(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def confirm_enrollment(
        %{assigns: %{current_subject: {:user, user}, current_session_id: session_id}} = conn,
        %{"enrollment_token" => token, "code" => code}
      )
      when is_binary(token) and is_binary(code) do
    with {:ok, %{"user_id" => user_id, "secret" => secret}} <- verify_enrollment_token(token),
         true <- user_id == user.id,
         {:ok, recovery_codes} <-
           Accounts.confirm_totp_enrollment(
             user,
             session_id,
             secret,
             code,
             System.system_time(:second)
           ) do
      json(conn, %{enabled: true, recovery_codes: recovery_codes})
    else
      false -> {:error, :invalid_two_factor}
      {:error, :expired} -> {:error, :invalid_two_factor}
      {:error, :invalid} -> {:error, :invalid_two_factor}
      {:error, _} = err -> err
    end
  end

  def confirm_enrollment(_, _), do: {:error, :bad_request}

  @doc "Disables TOTP using the account password and revokes other sessions."
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def delete(
        %{assigns: %{current_subject: {:user, user}, current_session_id: session_id}} = conn,
        %{"password" => password}
      )
      when is_binary(password) do
    with {:ok, _} <- Accounts.disable_totp(user, session_id, password) do
      json(conn, %{enabled: false})
    end
  end

  def delete(_, _), do: {:error, :bad_request}

  defp verify_enrollment_token(token) do
    Phoenix.Token.verify(GrappaWeb.Endpoint, @enrollment_salt, token, max_age: @enrollment_max_age_seconds)
  end
end
