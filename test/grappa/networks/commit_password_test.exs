defmodule Grappa.Networks.CommitPasswordTest do
  @moduledoc """
  #131 — in-session NickServ SET PASSWD capture, user-bound credential
  home. `Credentials.commit_password/3` is the id-keyed write
  Session.Server's `credential_committer` callback invokes when it
  observes a well-formed SET PASSWD leaving the wire (optimistic
  commit-on-send). Mirror of the visitor-side `Visitors.commit_password/2`
  and the sibling id-keyed `update_last_joined_channels/3`.

  Async-safe: each test sets up a unique user/network pair via fixtures.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.Repo

  defp setup_credential(attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: 6667, slug: "test-#{System.unique_integer([:positive])}")

    cred =
      credential_fixture(
        user,
        network,
        Map.merge(%{auth_method: :nickserv_identify, password: "oldpass"}, attrs)
      )

    {user, network, cred}
  end

  defp reload(%Credential{} = cred) do
    Repo.get_by!(Credential, user_id: cred.user_id, network_id: cred.network_id)
  end

  describe "Credentials.commit_password/3" do
    test "rotates the stored password and round-trips on read (Cloak decrypt)" do
      {_, _, cred} = setup_credential()
      # password_encrypted carries the DECRYPTED plaintext after load.
      assert cred.password_encrypted == "oldpass"

      assert {:ok, %Credential{}} =
               Credentials.commit_password(cred.user_id, cred.network_id, "newpass")

      assert reload(cred).password_encrypted == "newpass"
    end

    test "preserves every other field — only the password rotates" do
      {_, _, cred} = setup_credential(%{nick: "vjt", autojoin_channels: ["#grappa", "#italia"]})

      assert {:ok, _} = Credentials.commit_password(cred.user_id, cred.network_id, "newpass")

      reloaded = reload(cred)
      assert reloaded.nick == "vjt"
      assert reloaded.auth_method == :nickserv_identify
      assert reloaded.autojoin_channels == ["#grappa", "#italia"]
      assert reloaded.password_encrypted == "newpass"
    end

    test "stores a rest-of-line password verbatim, spaces included" do
      {_, _, cred} = setup_credential()

      assert {:ok, _} =
               Credentials.commit_password(cred.user_id, cred.network_id, "my new pass phrase")

      assert reload(cred).password_encrypted == "my new pass phrase"
    end

    test "{:error, :not_found} for an unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.commit_password(Ecto.UUID.generate(), 999_999, "newpass")
    end
  end

  describe "Credential.password_changeset/2" do
    test "casts and encrypts the new password, touching nothing else" do
      {_, _, cred} = setup_credential(%{autojoin_channels: ["#grappa"]})

      cs = Credential.password_changeset(cred, "newpass")

      assert cs.valid?
      # The virtual :password is cast; put_encrypted_password copies it into
      # :password_encrypted (Cloak encrypts at the DB boundary on update).
      assert Ecto.Changeset.get_change(cs, :password_encrypted) == "newpass"
      # No other field is touched — autojoin et al. are untouched changes.
      refute Map.has_key?(cs.changes, :autojoin_channels)
      refute Map.has_key?(cs.changes, :nick)
    end

    test "rejects a blank password at the changeset boundary" do
      {_, _, cred} = setup_credential()

      refute Credential.password_changeset(cred, "").valid?
    end
  end
end
