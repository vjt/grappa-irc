defmodule GrappaWeb.RecoveryCodeDoorsTest do
  @moduledoc """
  The class guard for #766: an armed recovery set always has a door.

  Recovery codes are ONE flat account-level credential shared by TOTP and
  passkey login (`Grappa.Accounts.RecoveryCodes`), and `drop_if_orphaned/1`
  deliberately preserves the set while ANY factor is armed. So every state
  that arms the set — and demands a second factor at login — owes it a
  redemption path. #766 is one instance of that rule being broken
  (`passkey_mode: :second_factor` with TOTP disarmed, reachable by switching
  a passwordless account to second factor); the matrix below is the rule.

  The door is not the same everywhere, and deliberately so: a passwordless
  account redeems the code ALONE (the code stands in for the passkey, its
  only factor), while every other state redeems it BEHIND the password (the
  code stands in for the second factor, not for both). Collapsing the two
  into one passkey_mode-blind door would turn a 2FA account into a
  one-credential account.
  """
  use GrappaWeb.ConnCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Repo}
  alias Grappa.Accounts.{Passkey, Session, TOTP, TOTPRecoveryCode, User, WebAuthn}
  alias Grappa.RateLimit.FailureWindow

  @states [
    :passwordless,
    :second_factor_with_totp,
    :second_factor_without_totp,
    :totp_only
  ]

  for state <- @states do
    test "#{state}: the armed recovery set is spendable", %{conn: conn} do
      %{user: user, password: password, code: code, door: door} = arm(unquote(state))

      body = redeem(conn, door, user, password, code)

      assert is_binary(body["token"])
      assert body["subject"]["id"] == user.id
      # Spent, not waved through: a door that minted a session without
      # consuming the code would satisfy the assertion above.
      assert codes_left(user) == 9
    end
  end

  # The widened branch must not be the cheap one. It shares the post-password
  # `:totp_login` window with the TOTP door, so the eleventh attempt is
  # refused even when the code handed over is genuine.
  test "the second_factor-without-TOTP door is inside the same failure window", %{conn: conn} do
    %{user: user, password: password, code: code} = arm(:second_factor_without_totp)
    on_exit(fn -> FailureWindow.clear(:totp_login, {"127.0.0.1", user.id}) end)

    live = session_count(user)
    challenge = challenge_token(conn, user, password)

    for _ <- 1..10 do
      assert conn
             |> post("/auth/totp/verify", %{
               "challenge_token" => challenge,
               "code" => "wrongwrongwrongwrongwrongw"
             })
             |> json_response(401) == %{"error" => "invalid_two_factor"}
    end

    assert conn
           |> post("/auth/totp/verify", %{"challenge_token" => challenge, "code" => code})
           |> json_response(429) == %{"error" => "too_many_attempts"}

    assert session_count(user) == live
    assert codes_left(user) == 10

    # The window was the only thing refusing it: the very same code opens
    # the door once the counter is cleared. Without this the 429 above
    # would also be satisfied by a code no door can ever redeem, which is
    # precisely the bug under test.
    :ok = FailureWindow.clear(:totp_login, {"127.0.0.1", user.id})

    assert conn
           |> post("/auth/totp/verify", %{"challenge_token" => challenge, "code" => code})
           |> json_response(200)
           |> Map.fetch!("subject")
           |> Map.fetch!("id") == user.id

    assert codes_left(user) == 9
  end

  # The pin for the door NOT widened. `/auth/passkeys/recover` mints a
  # session from a recovery code alone, which is the right trade for a
  # passwordless account (one factor in, one factor out) and the wrong one
  # for a second_factor account, whose password is the first factor. Widening
  # this door instead of the post-password one would close #766 by demoting
  # a 2FA account to a single credential.
  test "the passwordless door still refuses a second_factor account", %{conn: conn} do
    %{user: user, code: code} = arm(:second_factor_without_totp)
    live = session_count(user)

    on_exit(fn ->
      FailureWindow.clear(:passkey_recovery, "127.0.0.1")
      FailureWindow.clear(:passkey_recovery, {"127.0.0.1", user.id})
    end)

    assert conn
           |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => code})
           |> json_response(401) == %{"error" => "invalid_two_factor"}

    assert session_count(user) == live
    assert codes_left(user) == 10
  end

  defp arm(:passwordless) do
    {user, password} = user_fixture_with_password()
    register_passkey(user)
    codes = Accounts.prepare_recovery_codes()
    {:ok, :passwordless} = WebAuthn.set_mode(user, :passwordless, session_fixture(user).id, codes)

    %{user: reload(user), password: password, code: hd(codes), door: :passwordless_recovery}
  end

  defp arm(:second_factor_with_totp) do
    {user, password} = user_fixture_with_password()
    register_passkey(user)
    codes = arm_totp(user)
    {:ok, :second_factor} = WebAuthn.set_mode(user, :second_factor, session_fixture(user).id, [])

    %{user: reload(user), password: password, code: hd(codes), door: :post_password}
  end

  # The reachable path into #766's state: a passwordless account (the only
  # mode that mints codes without TOTP) switched to second factor. The set
  # survives because `drop_if_orphaned/1` counts second_factor as armed.
  defp arm(:second_factor_without_totp) do
    {user, password} = user_fixture_with_password()
    register_passkey(user)
    codes = Accounts.prepare_recovery_codes()
    session = session_fixture(user)
    {:ok, :passwordless} = WebAuthn.set_mode(user, :passwordless, session.id, codes)
    {:ok, :second_factor} = WebAuthn.set_mode(reload(user), :second_factor, session.id, [])

    stranded = reload(user)
    refute TOTP.enabled?(stranded)
    assert codes_left(stranded) == 10

    %{user: stranded, password: password, code: hd(codes), door: :post_password}
  end

  defp arm(:totp_only) do
    {user, password} = user_fixture_with_password()
    codes = arm_totp(user)

    %{user: reload(user), password: password, code: hd(codes), door: :post_password}
  end

  defp redeem(conn, :passwordless_recovery, user, _, code) do
    conn
    |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => code})
    |> json_response(200)
  end

  defp redeem(conn, :post_password, user, password, code) do
    conn
    |> post("/auth/totp/verify", %{
      "challenge_token" => challenge_token(conn, user, password),
      "code" => code
    })
    |> json_response(200)
  end

  defp challenge_token(conn, user, password) do
    pending =
      conn
      |> post("/auth/login", %{"identifier" => user.name, "password" => password})
      |> json_response(202)

    assert pending["two_factor_required"] == true
    token = pending["challenge_token"]
    assert is_binary(token), "no post-password door: the login handed out no challenge token"
    token
  end

  defp arm_totp(user) do
    enrollment = TOTP.new_enrollment(user, "Grappa test")
    at = System.system_time(:second)
    {:ok, code} = TOTP.code_at(enrollment.secret, at)
    {:ok, codes} = TOTP.confirm_enrollment(user, enrollment.secret, code, at)
    codes
  end

  defp register_passkey(user) do
    Repo.insert!(
      Passkey.changeset(%Passkey{}, %{
        user_id: user.id,
        credential_id: :crypto.strong_rand_bytes(16),
        public_key: CBOR.encode(%{1 => 2, 3 => -7}),
        name: "phone"
      })
    )
  end

  defp reload(user), do: Repo.get!(User, user.id)

  defp codes_left(user) do
    TOTPRecoveryCode
    |> where([r], r.user_id == ^user.id)
    |> Repo.aggregate(:count)
  end

  defp session_count(user) do
    Session
    |> where([s], s.user_id == ^user.id and is_nil(s.revoked_at))
    |> Repo.aggregate(:count)
  end
end
