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

  test "disable requires password and removes secret plus recovery codes" do
    {user, password} = user_fixture_with_password()
    {_, _} = arm(user)

    assert {:error, :invalid_credentials} = TOTP.disable(user, "wrong-password")
    assert {:ok, disabled} = TOTP.disable(user, password)
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

  test "new enrollment URI contains issuer, account, and secret" do
    user = user_fixture(name: "alice")
    enrollment = TOTP.new_enrollment(user, "Grappa (irc.example)")

    assert String.starts_with?(enrollment.provisioning_uri, "otpauth://totp/")
    assert enrollment.provisioning_uri =~ "issuer=Grappa+%28irc.example%29"
    assert enrollment.provisioning_uri =~ "secret=#{enrollment.secret}"
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
