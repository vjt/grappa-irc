defmodule GrappaWeb.TotpControllerTest do
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Session, Accounts.TOTP, Accounts.TOTPRecoveryCode, Repo}

  test "user enrolls TOTP, sees recovery codes once, and other sessions are revoked", %{conn: conn} do
    {user, _} = user_fixture_with_password()
    current = session_fixture(user)
    other = session_fixture(user)

    enrollment =
      conn
      |> put_bearer(current.id)
      |> post("/me/totp/enrollment", %{})
      |> json_response(200)

    {:ok, code} = TOTP.code_at(enrollment["secret"], System.system_time(:second))

    confirmed =
      conn
      |> put_bearer(current.id)
      |> post("/me/totp/enrollment/confirm", %{
        "enrollment_token" => enrollment["enrollment_token"],
        "code" => code
      })
      |> json_response(200)

    assert confirmed["enabled"] == true
    assert length(confirmed["recovery_codes"]) == 10
    assert is_nil(Repo.get!(Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Session, other.id).revoked_at

    status =
      conn
      |> put_bearer(current.id)
      |> get("/me/totp")
      |> json_response(200)

    assert status == %{"enabled" => true}
  end

  test "enrollment rolls back when other-session revocation fails", %{conn: conn} do
    {user, _} = user_fixture_with_password()
    current = session_fixture(user)
    other = session_fixture(user)

    enrollment =
      conn
      |> put_bearer(current.id)
      |> post("/me/totp/enrollment", %{})
      |> json_response(200)

    {:ok, code} = TOTP.code_at(enrollment["secret"], System.system_time(:second))

    Repo.query!("""
    CREATE TEMP TRIGGER totp_revoke_abort
    BEFORE UPDATE OF revoked_at ON sessions
    WHEN OLD.id = '#{other.id}'
    BEGIN
      SELECT RAISE(ABORT, 'forced revoke failure');
    END
    """)

    try do
      assert_raise Exqlite.Error, fn ->
        conn
        |> put_bearer(current.id)
        |> post("/me/totp/enrollment/confirm", %{
          "enrollment_token" => enrollment["enrollment_token"],
          "code" => code
        })
      end
    after
      Repo.query!("DROP TRIGGER totp_revoke_abort")
    end

    refute TOTP.enabled?(Accounts.get_user!(user.id))
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert is_nil(Repo.get!(Session, other.id).revoked_at)
  end

  test "visitor cannot access account TOTP settings", %{conn: conn} do
    {_, session} = visitor_and_session()

    response = conn |> put_bearer(session.id) |> get("/me/totp")
    assert json_response(response, 403) == %{"error" => "forbidden"}
  end

  test "disable accepts password only, removes TOTP, and revokes other sessions", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    secret = TOTP.new_enrollment(user, "Grappa test").secret
    {:ok, code} = TOTP.code_at(secret, System.system_time(:second))
    {:ok, _} = TOTP.confirm_enrollment(user, secret, code, System.system_time(:second))
    armed_user = Accounts.get_user!(user.id)
    current = session_fixture(armed_user)
    other = session_fixture(armed_user)

    response =
      conn
      |> put_bearer(current.id)
      |> delete("/me/totp", %{"password" => password})

    assert json_response(response, 200) == %{"enabled" => false}
    refute TOTP.enabled?(Accounts.get_user!(user.id))
    assert is_nil(Repo.get!(Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Session, other.id).revoked_at
  end

  test "wrong password cannot disable TOTP", %{conn: conn} do
    {user, _} = user_fixture_with_password()
    secret = TOTP.new_enrollment(user, "Grappa test").secret
    {:ok, code} = TOTP.code_at(secret, System.system_time(:second))
    {:ok, _} = TOTP.confirm_enrollment(user, secret, code, System.system_time(:second))
    session = session_fixture(Accounts.get_user!(user.id))

    response =
      conn
      |> put_bearer(session.id)
      |> delete("/me/totp", %{"password" => "wrong-password"})

    assert json_response(response, 401) == %{"error" => "invalid_credentials"}
    assert TOTP.enabled?(Accounts.get_user!(user.id))
  end
end
