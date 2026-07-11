defmodule Grappa.Networks.Credentials.UpsertVisitorCredentialTest do
  @moduledoc """
  #211 phase 3 — the visitor→Credential write-path choke-point.

  `Credentials.upsert_visitor_credential/3` is the single idempotent
  verb that keeps a visitor's `(visitor_id, network_id)` Credential
  current — reused by BOTH the per-mutation write-through in
  `Grappa.Visitors` AND the bulk reconcile in `Grappa.Bootstrap`. It
  takes primitives (no `%Visitor{}`) so `Grappa.Networks` needs no
  `Grappa.Visitors` dep (the FK stays a dirty_xref).

  `get_visitor_credential/2` is the subject-scoped reader
  (`WHERE visitor_id ==`, never `user_id ==`) the read-cutover uses —
  subject-aware by construction, so it can never route a visitor row
  into the user resolver's `Accounts.get_user!(nil)` crash
  ([[feedback_xor_fk_promotion_audit]]).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials}

  describe "get_visitor_credential/2" do
    test "returns the visitor's credential scoped by visitor_id" do
      {visitor, network} = visitor_with_network(6667)

      # Backfill-equivalent: create the credential via the upsert.
      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: visitor.nick,
          auth_method: :none
        })

      assert {:ok, %Credential{} = cred} =
               Credentials.get_visitor_credential(visitor.id, network.id)

      assert cred.visitor_id == visitor.id
      assert is_nil(cred.user_id)
      assert cred.network_id == network.id
      assert cred.nick == visitor.nick
    end

    test "returns {:error, :not_found} when no visitor credential exists" do
      {visitor, network} = visitor_with_network(6667)

      assert {:error, :not_found} =
               Credentials.get_visitor_credential(visitor.id, network.id)
    end

    test "does NOT return a user credential (subject isolation)" do
      user = user_fixture()
      network = network_fixture()
      _ = credential_fixture(user, network, %{nick: "usernick"})
      visitor = visitor_fixture(network_slug: network.slug)

      # A visitor-scoped read must not surface the user's credential on
      # the same network — the whole point of the subject-scoped reader.
      assert {:error, :not_found} =
               Credentials.get_visitor_credential(visitor.id, network.id)
    end
  end

  describe "upsert_visitor_credential/3 — create" do
    test "creates a visitor credential when none exists" do
      {visitor, network} = visitor_with_network(6667)

      assert {:ok, %Credential{} = cred} =
               Credentials.upsert_visitor_credential(visitor.id, network.id, %{
                 nick: "freshnick",
                 ident: "freshident",
                 realname: "Fresh Real",
                 auth_method: :none
               })

      assert cred.visitor_id == visitor.id
      assert is_nil(cred.user_id)
      assert cred.nick == "freshnick"
      assert cred.ident == "freshident"
      assert cred.realname == "Fresh Real"
      assert cred.auth_method == :none
    end

    test "stores the password encrypted-at-rest via the virtual field" do
      {visitor, network} = visitor_with_network(6667)

      assert {:ok, cred} =
               Credentials.upsert_visitor_credential(visitor.id, network.id, %{
                 nick: "pwnick",
                 auth_method: :nickserv_identify,
                 password: "s3cret"
               })

      # In-memory post-load the EncryptedBinary field carries plaintext.
      assert Credential.upstream_password(cred) == "s3cret"

      # And a re-read decrypts back to the same plaintext (Cloak round-trip).
      assert {:ok, reread} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert Credential.upstream_password(reread) == "s3cret"
    end
  end

  describe "upsert_visitor_credential/3 — update (idempotent refresh)" do
    test "updates an existing visitor credential in place (no duplicate row)" do
      {visitor, network} = visitor_with_network(6667)

      {:ok, first} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "oldnick",
          auth_method: :none
        })

      {:ok, second} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "newnick",
          ident: "newident",
          auth_method: :none
        })

      # Same surrogate row id — updated in place, not a second insert.
      assert second.id == first.id
      assert second.nick == "newnick"
      assert second.ident == "newident"

      # Exactly one credential for (visitor, network).
      assert {:ok, _} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert count_visitor_credentials(visitor.id, network.id) == 1
    end

    test "re-running with identical attrs is a no-op (idempotent)" do
      {visitor, network} = visitor_with_network(6667)
      attrs = %{nick: "stable", ident: "stable", auth_method: :none}

      {:ok, a} = Credentials.upsert_visitor_credential(visitor.id, network.id, attrs)
      {:ok, b} = Credentials.upsert_visitor_credential(visitor.id, network.id, attrs)

      assert a.id == b.id
      assert count_visitor_credentials(visitor.id, network.id) == 1
    end

    test "promotes anon→registered by adding a password on update" do
      {visitor, network} = visitor_with_network(6667)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "vjt",
          auth_method: :none
        })

      {:ok, registered} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "afterpass"
        })

      assert registered.auth_method == :nickserv_identify
      assert Credential.upstream_password(registered) == "afterpass"
    end
  end

  defp count_visitor_credentials(visitor_id, network_id) do
    import Ecto.Query

    query = from(c in Credential, where: c.visitor_id == ^visitor_id and c.network_id == ^network_id)
    Repo.aggregate(query, :count, :id)
  end
end
