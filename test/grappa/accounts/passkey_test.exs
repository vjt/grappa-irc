defmodule Grappa.Accounts.PasskeyTest do
  use Grappa.DataCase, async: true

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Passkey, Accounts.TOTPRecoveryCode, Accounts.WebAuthn, Repo}

  test "registration options are RP-bound and password-gated" do
    {user, password} = user_fixture_with_password()
    binding = %{ip: "192.0.2.1", client_id: "client"}

    assert {:error, :invalid_credentials} =
             WebAuthn.begin_registration(user, "wrong-password", "phone", binding, "https://irc.example")

    assert {:ok, %{challenge_id: id, public_key: options}} =
             WebAuthn.begin_registration(user, password, "phone", binding, "https://irc.example")

    assert is_binary(id)
    assert options.rp.id == "irc.example"
    assert options.user.name == user.name
    assert options.authenticator_selection.user_verification == "required"
  end

  describe "begin_authentication/5 credential exposure" do
    setup do
      user = user_fixture()
      other = user_fixture()
      key = %{1 => 2, 3 => -7, -1 => 1, -2 => <<0::256>>, -3 => <<0::256>>}

      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: <<1, 2, 3>>,
          public_key: CBOR.encode(key),
          name: "phone",
          transports: %{"values" => ["usb"]}
        })
      )

      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: other.id,
          credential_id: <<4, 5, 6>>,
          public_key: CBOR.encode(key),
          name: "other"
        })
      )

      %{user: user, binding: %{ip: "192.0.2.1", client_id: nil}}
    end

    test "passwordless stays discoverable and hands no credential id to an anonymous caller", ctx do
      assert {:ok, %{public_key: options}} =
               WebAuthn.begin_authentication(ctx.user, :passwordless, ctx.binding, "https://irc.example", %{})

      assert options.rp_id == "irc.example"
      refute Map.has_key?(options, :allow_credentials)
    end

    for purpose <- [:second_factor, :mode_change] do
      test "#{purpose} lists the account's own credentials so a non-discoverable key can answer", ctx do
        assert {:ok, %{public_key: options}} =
                 WebAuthn.begin_authentication(ctx.user, unquote(purpose), ctx.binding, "https://irc.example", %{})

        assert [%{type: "public-key", id: id, transports: ["usb"]}] = options.allow_credentials
        assert Base.url_decode64!(id, padding: false) == <<1, 2, 3>>
      end
    end

    test "an account with no transports hint omits the key rather than sending an empty list", ctx do
      Repo.update_all(Passkey, set: [transports: %{}])

      assert {:ok, %{public_key: options}} =
               WebAuthn.begin_authentication(ctx.user, :second_factor, ctx.binding, "https://irc.example", %{})

      assert [credential] = options.allow_credentials
      refute Map.has_key?(credential, :transports)
    end
  end

  describe "consume_sign_count/2" do
    setup do
      user = user_fixture()

      passkey =
        Repo.insert!(
          Passkey.changeset(%Passkey{}, %{
            user_id: user.id,
            credential_id: <<1, 2, 3>>,
            public_key: CBOR.encode(%{1 => 2}),
            name: "phone",
            sign_count: 5
          })
        )

      %{user: user, passkey: passkey}
    end

    test "an advancing counter is accepted and stored", ctx do
      assert :ok = WebAuthn.consume_sign_count(ctx.passkey, 6)

      reloaded = Repo.get!(Passkey, ctx.passkey.id)
      assert reloaded.sign_count == 6
      assert %DateTime{} = reloaded.last_used_at
    end

    test "an authenticator that never counted keeps its zero", ctx do
      zeroed = Repo.update!(Ecto.Changeset.change(ctx.passkey, sign_count: 0))

      assert :ok = WebAuthn.consume_sign_count(zeroed, 0)
      assert Repo.get!(Passkey, zeroed.id).sign_count == 0
    end

    test "a zero from a credential that HAS counted is refused, and the counter survives", ctx do
      assert {:error, :cloned_authenticator} = WebAuthn.consume_sign_count(ctx.passkey, 0)
      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 5
    end

    for presented <- [4, 5] do
      test "a counter that did not advance (#{presented} against 5) is refused", ctx do
        assert {:error, :cloned_authenticator} =
                 WebAuthn.consume_sign_count(ctx.passkey, unquote(presented))

        assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 5
      end
    end

    test "an assertion whose counter was already consumed by another loses the race", ctx do
      Repo.update_all(Passkey, set: [sign_count: 7])

      assert {:error, :cloned_authenticator} = WebAuthn.consume_sign_count(ctx.passkey, 6)
      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 7
    end

    test "the refusal is logged, because the wire deliberately says nothing", ctx do
      log = capture_log(fn -> WebAuthn.consume_sign_count(ctx.passkey, 0) end)

      assert log =~ "sign counter did not advance"
      assert log =~ ctx.passkey.id
      assert log =~ ctx.user.id
    end
  end

  test "passwordless activation persists the pre-shown recovery set only at commit" do
    user = user_fixture()
    current = session_fixture(user)
    other = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()

    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert {:ok, :passwordless} = WebAuthn.set_mode(user, :passwordless, current.id, codes)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    assert Repo.get!(Accounts.User, user.id).passkey_mode == :passwordless
    assert is_nil(Repo.get!(Accounts.Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Accounts.Session, other.id).revoked_at
  end

  test "disabling passkey login removes recovery codes and revokes other sessions" do
    user = user_fixture()
    current = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()

    assert {:ok, :passwordless} = WebAuthn.set_mode(user, :passwordless, current.id, codes)

    other = session_fixture(user)
    passwordless_user = Repo.get!(Accounts.User, user.id)
    assert {:ok, :disabled} = WebAuthn.set_mode(passwordless_user, :disabled, current.id, [])
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert Repo.get!(Accounts.User, passwordless_user.id).passkey_mode == :disabled
    assert is_nil(Repo.get!(Accounts.Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Accounts.Session, other.id).revoked_at
  end

  # The recovery set is ONE flat account-level set with no record of which
  # factor minted it, so a teardown may only destroy it once nothing is
  # left that could redeem it. Both directions are asserted here because
  # the earlier guard got each one wrong in a different way: it wiped the
  # codes a surviving TOTP still needed, and it kept codes no factor could
  # ever spend.
  describe "set_mode/4 recovery-set teardown" do
    setup do
      user = user_fixture()
      %{user: user, session: session_fixture(user)}
    end

    test "disabling passwordless keeps the codes an armed TOTP still needs", ctx do
      armed = arm_totp(ctx.user)
      {:ok, :passwordless} = WebAuthn.set_mode(armed, :passwordless, ctx.session.id, codes())

      passwordless = Repo.get!(Accounts.User, armed.id)
      assert {:ok, :disabled} = WebAuthn.set_mode(passwordless, :disabled, ctx.session.id, [])
      assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    end

    test "disabling second-factor keeps the codes an armed TOTP still needs", ctx do
      armed = arm_totp(ctx.user)
      second_factor = set_passkey_mode(armed, :second_factor)

      assert {:ok, :disabled} = WebAuthn.set_mode(second_factor, :disabled, ctx.session.id, [])
      assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    end

    test "disabling second-factor with no other factor takes the codes with it", ctx do
      :ok = Accounts.RecoveryCodes.replace(ctx.user.id, codes())
      second_factor = set_passkey_mode(ctx.user, :second_factor)

      assert {:ok, :disabled} = WebAuthn.set_mode(second_factor, :disabled, ctx.session.id, [])
      assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    end

    test "moving passwordless to second-factor keeps the codes, still armed", ctx do
      {:ok, :passwordless} = WebAuthn.set_mode(ctx.user, :passwordless, ctx.session.id, codes())

      passwordless = Repo.get!(Accounts.User, ctx.user.id)
      assert {:ok, :second_factor} = WebAuthn.set_mode(passwordless, :second_factor, ctx.session.id, [])
      assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    end
  end

  # Counting the credentials and then deleting one is two statements, and
  # two concurrent requests both saw two credentials and both went ahead —
  # a passwordless account ends with zero passkeys and no door at all. The
  # count belongs INSIDE the delete, which is what these assert: the second
  # delete re-decides against the row the first one removed. A true
  # concurrent race cannot be staged here (the sandbox serialises both
  # processes onto one connection), so the sequential pair is what proves
  # the guard moved into the statement rather than reading a stale count.
  describe "delete/2 last-credential guard" do
    setup do
      user = user_fixture()
      %{user: user, session: session_fixture(user)}
    end

    defp add_passkey(user, credential_id) do
      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: credential_id,
          public_key: CBOR.encode(%{1 => 2}),
          name: "key-#{byte_size(credential_id)}"
        })
      )
    end

    test "an armed account keeps the last credential it depends on", ctx do
      passkey = add_passkey(ctx.user, <<1>>)
      {:ok, :passwordless} = WebAuthn.set_mode(ctx.user, :passwordless, ctx.session.id, codes())
      armed = Repo.get!(Accounts.User, ctx.user.id)

      assert {:error, :passkey_required} = WebAuthn.delete(armed, passkey.id)
      assert Repo.aggregate(Passkey, :count, :id) == 1
    end

    test "the delete itself re-decides, so the second of two cannot empty the account", ctx do
      first = add_passkey(ctx.user, <<1>>)
      second = add_passkey(ctx.user, <<2, 2>>)
      {:ok, :passwordless} = WebAuthn.set_mode(ctx.user, :passwordless, ctx.session.id, codes())
      armed = Repo.get!(Accounts.User, ctx.user.id)

      assert :ok = WebAuthn.delete(armed, first.id)
      assert {:error, :passkey_required} = WebAuthn.delete(armed, second.id)
      assert Repo.aggregate(Passkey, :count, :id) == 1
    end

    test "an account back on password login may remove its last credential", ctx do
      passkey = add_passkey(ctx.user, <<1>>)

      assert :ok = WebAuthn.delete(ctx.user, passkey.id)
      assert Repo.aggregate(Passkey, :count, :id) == 0
    end

    # #768 — the delete is a WRITE, so a transient SQLITE_BUSY under WAL with
    # pool_size > 1 used to raise straight out of `Repo.delete_all/1` and land
    # on the caller as a 500. Wrapped in `Repo.BusyRetry`, sustained saturation
    # degrades to `{:error, :db_unavailable}` — the token FallbackController
    # already turns into a clean 503. The pool_size:1 Sandbox cannot produce a
    # real busy, so the engine's :test-only per-process fault seam forces one
    # (same lever as the #523 themes-copy repro); ExUnit gives each test its
    # own process, so the injection cannot leak.
    test "a delete held off by a saturated writer degrades, it does not raise", ctx do
      passkey = add_passkey(ctx.user, <<1>>)
      Repo.BusyRetry.inject_transient_faults(10_000)

      assert {:error, :db_unavailable} = WebAuthn.delete(ctx.user, passkey.id)

      Repo.BusyRetry.inject_transient_faults(0)
      assert Repo.aggregate(Passkey, :count, :id) == 1
    end

    test "a credential owned by someone else is not found, armed or not", ctx do
      other = add_passkey(user_fixture(), <<3>>)
      {:ok, :passwordless} = WebAuthn.set_mode(ctx.user, :passwordless, ctx.session.id, codes())
      armed = Repo.get!(Accounts.User, ctx.user.id)

      assert {:error, :not_found} = WebAuthn.delete(armed, other.id)
      assert Repo.aggregate(Passkey, :count, :id) == 1
    end
  end

  # The mode decides which login door an account gets, so a value outside
  # the set is not a cosmetic problem: `!= "disabled"` reads TRUE for it and
  # no door matches, which wedges the account with no error anywhere. The
  # column refuses to hold one at all, which is why this reaches for raw SQL
  # — nothing above it can even express the write.
  describe "passkey_mode closed set" do
    test "a mode outside the set cannot be loaded back as an account" do
      user = user_fixture()
      Repo.query!("UPDATE users SET passkey_mode = 'bogus' WHERE name = ?", [user.name])

      assert_raise ArgumentError, fn -> Repo.get!(Accounts.User, user.id) end
    end

    test "the wire spelling of every mode decodes, and nothing else does" do
      assert {:ok, :disabled} = WebAuthn.decode_mode("disabled")
      assert {:ok, :second_factor} = WebAuthn.decode_mode("second_factor")
      assert {:ok, :passwordless} = WebAuthn.decode_mode("passwordless")

      assert {:error, :invalid_mode} = WebAuthn.decode_mode("bogus")
      assert {:error, :invalid_mode} = WebAuthn.decode_mode(:disabled)
      assert {:error, :invalid_mode} = WebAuthn.decode_mode(nil)
    end
  end

  defp codes, do: Accounts.prepare_recovery_codes()

  defp set_passkey_mode(user, mode) do
    user |> Ecto.Changeset.change(passkey_mode: mode) |> Repo.update!()
    Repo.get!(Accounts.User, user.id)
  end

  defp arm_totp(user) do
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    now = 1_700_000_000
    {:ok, code} = Accounts.TOTP.code_at(secret, now)
    {:ok, _} = Accounts.TOTP.confirm_enrollment(user, secret, code, now)
    Repo.get!(Accounts.User, user.id)
  end
end
