defmodule Grappa.Accounts.TOTPTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Session, Accounts.TOTP, Accounts.TOTPRecoveryCode, Accounts.User, Repo}
  alias Grappa.Repo.BusyRetry

  @rfc_secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

  test "code_at/2 matches RFC 6238 SHA-1 vectors" do
    assert {:ok, "287082"} = TOTP.code_at(@rfc_secret, 59)
    assert {:ok, "081804"} = TOTP.code_at(@rfc_secret, 1_111_111_109)
    assert {:ok, "050471"} = TOTP.code_at(@rfc_secret, 1_111_111_111)
    assert {:ok, "005924"} = TOTP.code_at(@rfc_secret, 1_234_567_890)
    assert {:ok, "279037"} = TOTP.code_at(@rfc_secret, 2_000_000_000)
    assert {:ok, "353130"} = TOTP.code_at(@rfc_secret, 20_000_000_000)
  end

  test "confirm arms encrypted secret and returns ten one-shot recovery codes" do
    user = user_fixture()
    now = 1_700_000_000
    {:ok, code} = TOTP.code_at(@rfc_secret, now)

    assert {:ok, recovery_codes} = TOTP.confirm_enrollment(user, @rfc_secret, code, now)
    assert length(recovery_codes) == 10
    assert Enum.all?(recovery_codes, &Regex.match?(~r/^[a-z2-7]{26}$/, &1))

    armed = Repo.get!(User, user.id)
    assert armed.totp_secret_encrypted == @rfc_secret

    [[stored_secret]] =
      Repo.query!("SELECT totp_secret_encrypted FROM users WHERE id = ?", [user.id]).rows

    assert is_binary(stored_secret)
    refute stored_secret == @rfc_secret
    assert %DateTime{} = armed.totp_enabled_at
    assert armed.totp_last_used_step == div(now, 30)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
  end

  test "same TOTP step cannot be consumed twice" do
    user = armed_user()
    now = 1_700_000_030
    {:ok, code} = TOTP.code_at(@rfc_secret, now)

    assert {:ok, :totp} = TOTP.verify(user, code, now)
    assert {:error, :two_factor_replayed} = TOTP.verify(user, code, now)
  end

  test "recovery code is deleted after one use" do
    {user, [recovery | _]} = armed_user_with_recovery_codes()

    assert {:ok, :recovery} = TOTP.verify(user, recovery, 1_700_000_030)
    assert {:error, :invalid_two_factor} = TOTP.verify(user, recovery, 1_700_000_030)
  end

  # One set, two doors. They must agree on normalisation and hashing or a
  # code minted behind one is unspendable at the other — and the account
  # holder has no way to tell which door their code belongs to.
  test "a code minted by TOTP enrolment is spendable at the passkey recovery door" do
    {user, [code | _]} = armed_user_with_recovery_codes()

    assert :ok = Accounts.consume_recovery_code(user, code)
    assert {:error, :invalid_recovery_code} = Accounts.consume_recovery_code(user, code)
  end

  test "a code spent at the passkey door is gone from the TOTP door too" do
    {user, [code | _]} = armed_user_with_recovery_codes()

    assert :ok = Accounts.consume_recovery_code(user, code)
    assert {:error, :invalid_two_factor} = TOTP.verify(user, code, 1_700_000_030)
  end

  test "disable requires password and removes secret plus recovery codes" do
    {user, password} = user_fixture_with_password()
    {armed, _} = arm(user)
    current = session_fixture(armed)

    assert {:error, :invalid_credentials} =
             Accounts.disable_totp(armed, current.id, "wrong-password")

    assert {:ok, disabled} = Accounts.disable_totp(armed, current.id, password)
    refute TOTP.enabled?(disabled)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
  end

  test "enrollment retries the complete transaction after transient contention" do
    user = user_fixture()
    current = session_fixture(user)
    other = session_fixture(user)
    now = 1_700_000_000
    {:ok, code} = TOTP.code_at(@rfc_secret, now)
    :ok = BusyRetry.inject_transient_faults(1)

    assert {:ok, recovery_codes} =
             Accounts.confirm_totp_enrollment(user, current.id, @rfc_secret, code, now)

    assert length(recovery_codes) == 10
    assert is_nil(Repo.get!(Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Session, other.id).revoked_at
  end

  test "disable retries the complete transaction after transient contention" do
    {user, password} = user_fixture_with_password()
    {armed, _} = arm(user)
    current = session_fixture(armed)
    other = session_fixture(armed)
    :ok = BusyRetry.inject_transient_faults(1)

    assert {:ok, disabled} = Accounts.disable_totp(armed, current.id, password)

    refute TOTP.enabled?(disabled)
    assert is_nil(Repo.get!(Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Session, other.id).revoked_at
  end

  # The label is what an authenticator app puts under the user's thumb, so
  # it has to name the ACCOUNT, not merely be present: built from `user.id`
  # instead of `user.name` the URI still parses, still carries the issuer,
  # still round-trips the secret, and every enrolled account shows up as a
  # UUID. The parameters are pinned for the same reason — RFC 6238 leaves
  # SHA1/6/30 as defaults, but `code_at/2` is not written against defaults,
  # so a URI that omits or contradicts them enrolls an app that computes
  # codes this server will refuse.
  test "new enrollment URI labels the account and pins the RFC 6238 parameters" do
    user = user_fixture(name: "alice")
    enrollment = TOTP.new_enrollment(user, "Grappa (irc.example)")

    assert %URI{scheme: "otpauth", host: "totp", path: path, query: query} =
             URI.parse(enrollment.provisioning_uri)

    assert URI.decode(path) == "/Grappa (irc.example):alice"

    params = URI.decode_query(query)
    assert params["issuer"] == "Grappa (irc.example)"
    assert params["algorithm"] == "SHA1"
    assert params["digits"] == "6"
    assert params["period"] == "30"

    # Not just an echo of the struct: the URI has to carry a secret the
    # authenticator can actually key on — 20 raw bytes, Base32, unpadded.
    assert params["secret"] == enrollment.secret
    assert {:ok, key} = Base.decode32(params["secret"], padding: false)
    assert byte_size(key) == 20
  end

  # The recovery set is shared, so disarming TOTP must not destroy a
  # surviving passkey factor's way back in — but once TOTP was the last
  # factor standing, leaving the codes behind would strand a live
  # credential on an account whose login is password-only again.
  test "reset_totp/1 disarms the factor and revokes sessions, keeping a passkey's recovery set" do
    {user, codes} = armed_user_with_recovery_codes()
    user |> Ecto.Changeset.change(passkey_mode: :passwordless) |> Repo.update!()
    session = session_fixture(user)
    assert TOTP.enabled?(user)

    {:ok, reset} = Accounts.reset_totp(user.name)

    refute TOTP.enabled?(reset)
    assert %DateTime{} = Repo.get!(Session, session.id).revoked_at
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == length(codes)
  end

  test "reset_totp/1 takes the recovery set with it when TOTP was the last factor" do
    {user, _} = armed_user_with_recovery_codes()
    assert Repo.get!(User, user.id).passkey_mode == :disabled

    {:ok, _} = Accounts.reset_totp(user.name)

    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
  end

  test "reset_passkeys/1 keeps the recovery set an armed TOTP still needs" do
    {user, codes} = armed_user_with_recovery_codes()
    user |> Ecto.Changeset.change(passkey_mode: :second_factor) |> Repo.update!()

    {:ok, _} = Accounts.reset_passkeys(user.name)

    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == length(codes)
  end

  test "reset_totp/1 reports an unknown account rather than succeeding silently" do
    assert {:error, :not_found} = Accounts.reset_totp("no-such-account")
  end

  defp armed_user do
    {user, _} = armed_user_with_recovery_codes()
    user
  end

  defp armed_user_with_recovery_codes do
    user = user_fixture()
    arm(user)
  end

  defp arm(user) do
    now = 1_700_000_000
    {:ok, code} = TOTP.code_at(@rfc_secret, now)
    {:ok, codes} = TOTP.confirm_enrollment(user, @rfc_secret, code, now)
    {Accounts.get_user!(user.id), codes}
  end
end
