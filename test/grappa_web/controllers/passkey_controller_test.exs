defmodule GrappaWeb.PasskeyControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Ecto.Query

  alias Grappa.Accounts.{Session, TOTP, TOTPRecoveryCode, User}
  alias Grappa.Repo

  test "passwordless mode rejects password and accepts a one-shot recovery code", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    secret = TOTP.new_enrollment(user, "Grappa test").secret
    now = System.system_time(:second)
    {:ok, code} = TOTP.code_at(secret, now)
    {:ok, [recovery | _]} = TOTP.confirm_enrollment(user, secret, code, now)

    User
    |> where([u], u.id == ^user.id)
    |> Repo.update_all(set: [passkey_mode: "passwordless"])

    rejected = post(conn, "/auth/login", %{"identifier" => user.name, "password" => password})
    assert json_response(rejected, 401) == %{"error" => "invalid_credentials"}

    body =
      conn
      |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
      |> json_response(200)

    assert is_binary(body["token"])

    replay = post(conn, "/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
    assert json_response(replay, 401) == %{"error" => "invalid_two_factor"}
  end

  test "recovery checkpoint does not activate passwordless or persist codes", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    prepared =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> post("/me/passkeys/passwordless/recovery", %{"password" => password})
      |> json_response(200)

    assert length(prepared["recovery_codes"]) == 10
    assert is_binary(prepared["recovery_token"])
    assert Repo.get!(User, user.id).passkey_mode == "disabled"
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert is_nil(Repo.get!(Session, session.id).revoked_at)
  end
end
