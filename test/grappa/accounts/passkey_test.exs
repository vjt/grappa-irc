defmodule Grappa.Accounts.PasskeyTest do
  use Grappa.DataCase, async: true

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
    assert options.authenticatorSelection.userVerification == "required"
  end

  test "authentication keeps account credentials server-side and uses discoverable client options" do
    user = user_fixture()
    other = user_fixture()
    key = %{1 => 2, 3 => -7, -1 => 1, -2 => <<0::256>>, -3 => <<0::256>>}

    Repo.insert!(
      Passkey.changeset(%Passkey{}, %{
        user_id: user.id,
        credential_id: <<1, 2, 3>>,
        public_key: :erlang.term_to_binary(key),
        name: "phone"
      })
    )

    Repo.insert!(
      Passkey.changeset(%Passkey{}, %{
        user_id: other.id,
        credential_id: <<4, 5, 6>>,
        public_key: :erlang.term_to_binary(key),
        name: "other"
      })
    )

    assert {:ok, %{public_key: options}} =
             WebAuthn.begin_authentication(
               user,
               :passwordless,
               %{ip: "192.0.2.1", client_id: nil},
               "https://irc.example"
             )

    assert options.rpId == "irc.example"
    refute Map.has_key?(options, :allowCredentials)
  end

  test "passwordless activation persists the pre-shown recovery set only at commit" do
    user = user_fixture()
    current = session_fixture(user)
    other = session_fixture(user)
    codes = Accounts.prepare_recovery_codes()

    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert {:ok, "passwordless"} = WebAuthn.set_mode(user, "passwordless", current.id, codes)
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 10
    assert Repo.get!(Accounts.User, user.id).passkey_mode == "passwordless"
    assert is_nil(Repo.get!(Accounts.Session, current.id).revoked_at)
    assert %DateTime{} = Repo.get!(Accounts.Session, other.id).revoked_at
  end
end
