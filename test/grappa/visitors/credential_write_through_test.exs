defmodule Grappa.Visitors.CredentialWriteThroughTest do
  @moduledoc """
  #211 phase 3 — every visitor identity mutation MUST also maintain the
  visitor's `(visitor_id, network_id)` Credential, because the read path
  (`Grappa.Visitors.SessionPlan.resolve/1`) now resolves from the
  Credential. This is vjt's mandatory write-path requirement: new /
  changed visitors get correct creds going forward, mooting the phase-1
  dormant-drift concern.

  Proves a NEW visitor created post-cutover gets a correct Credential
  with NO separate backfill run (the provision itself writes it).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.Visitors

  defp read(visitor, network), do: Credentials.get_visitor_credential(visitor.id, network.id)

  describe "find_or_provision_anon/3 (provision)" do
    test "a NEW anon visitor gets a matching Credential with no backfill run" do
      {_, network} = visitor_with_network(6667)
      slug = network.slug

      {:ok, visitor} = Visitors.find_or_provision_anon("freshvis", slug, "1.2.3.4")

      assert {:ok, %Credential{} = cred} = read(visitor, network)
      assert cred.visitor_id == visitor.id
      assert is_nil(cred.user_id)
      assert cred.nick == "freshvis"
      assert cred.auth_method == :none
      assert cred.sasl_user == "freshvis"
    end
  end

  describe "commit_password/2" do
    test "promotes the Credential to nickserv_identify with the password" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("pwvis", network.slug, "1.2.3.4")

      {:ok, _} = Visitors.commit_password(visitor.id, "topsecret")

      assert {:ok, cred} = read(visitor, network)
      assert cred.auth_method == :nickserv_identify
      assert Credential.upstream_password(cred) == "topsecret"
    end
  end

  describe "rotate_password/2" do
    test "rotates the Credential password for an already-registered visitor" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("rotvis", network.slug, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(visitor.id, "first")

      {:ok, _} = Visitors.rotate_password(visitor.id, "second")

      assert {:ok, cred} = read(visitor, network)
      assert cred.auth_method == :nickserv_identify
      assert Credential.upstream_password(cred) == "second"
    end
  end

  describe "update_nick/2" do
    test "rotates the Credential nick" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("oldn", network.slug, "1.2.3.4")

      {:ok, _} = Visitors.update_nick(visitor.id, "newn")

      assert {:ok, cred} = read(visitor, network)
      assert cred.nick == "newn"
      assert cred.sasl_user == "newn"
    end
  end

  describe "update_identity/2" do
    test "writes ident + realname onto the Credential BEFORE any reconnect" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("idvis", network.slug, "1.2.3.4")

      {:ok, _} = Visitors.update_identity(visitor, %{ident: "myident", realname: "My Real"})

      assert {:ok, cred} = read(visitor, network)
      assert cred.ident == "myident"
      assert cred.realname == "My Real"
    end
  end

  describe "update_last_joined_channels/3 (per-network, #211 phase 4c)" do
    test "writes the channel snapshot onto THIS network's Credential" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("chvis", network.slug, "1.2.3.4")

      :ok = Visitors.update_last_joined_channels(visitor.id, network.id, ["#alpha", "#beta"])

      assert {:ok, cred} = read(visitor, network)
      assert cred.last_joined_channels == ["#alpha", "#beta"]
    end
  end

  describe "remove_autojoin_channel/3 (per-network, #211 phase 4c)" do
    test "drops the channel from THIS network's Credential snapshot" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("rmvis", network.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, network.id, ["#alpha", "#beta"])
      fresh = Visitors.get!(visitor.id)

      {:ok, _} = Visitors.remove_autojoin_channel(fresh, network.id, "#alpha")

      assert {:ok, cred} = read(visitor, network)
      assert cred.last_joined_channels == ["#beta"]
    end
  end

  # #211 phase 4c — the multi-network isolation guard (the regression the
  # code-review flagged): a visitor whose credentials span networks A + B
  # must keep a DISTINCT channel set per network. Pre-fix the persister
  # wrote the single `visitors.last_joined_channels` scalar (+ the primary
  # credential), so two concurrent sessions clobbered each other's rejoin
  # lists. Post-fix each write is keyed on `(visitor_id, network_id)`.
  describe "per-network channel isolation across accreted networks" do
    test "network A and network B channel sets do NOT clobber each other" do
      {_, net_a} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("multichan", net_a.slug, "1.2.3.4")

      # Accrete B: a second credential on the SAME visitor identity.
      {net_b, _} = network_with_server(port: 6668, slug: "beta-chan", visitor_enabled: true)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: visitor.nick,
          sasl_user: visitor.nick,
          auth_method: :none
        })

      # Distinct channel sets per network.
      :ok = Visitors.update_last_joined_channels(visitor.id, net_a.id, ["#alpha-only"])
      :ok = Visitors.update_last_joined_channels(visitor.id, net_b.id, ["#beta-only"])

      # Each network keeps ITS OWN set — no cross-contamination.
      assert {:ok, cred_a} = read(visitor, net_a)
      assert {:ok, cred_b} = read(visitor, net_b)
      assert cred_a.last_joined_channels == ["#alpha-only"]
      assert cred_b.last_joined_channels == ["#beta-only"]

      # The per-network reader agrees.
      assert Visitors.list_autojoin_channels(visitor, net_a.id) == ["#alpha-only"]
      assert Visitors.list_autojoin_channels(visitor, net_b.id) == ["#beta-only"]

      # A dismiss on B does not touch A.
      {:ok, _} = Visitors.remove_autojoin_channel(visitor, net_b.id, "#beta-only")
      assert Visitors.list_autojoin_channels(visitor, net_a.id) == ["#alpha-only"]
      assert Visitors.list_autojoin_channels(visitor, net_b.id) == []
    end

    test "an identity nick-change sync does NOT clobber per-network channel sets" do
      {_, net_a} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("syncvis", net_a.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, net_a.id, ["#kept"])

      # An identity mutation fires sync_credential/1 — which must NOT reset
      # the credential's per-network channel list back to the visitor scalar
      # (credential_attrs no longer carries last_joined_channels).
      {:ok, _} = Visitors.update_nick(visitor.id, "syncvis2")

      assert Visitors.list_autojoin_channels(visitor, net_a.id) == ["#kept"]
    end
  end

  describe "orphan network slug" do
    test "mutation succeeds without crashing when the slug has no network" do
      # Visitor pinned to a slug with no networks row — credential write is
      # skipped (logged), the visitor mutation itself still succeeds.
      visitor = visitor_fixture(nick: "orphanvis", network_slug: "ghost-net")

      assert {:ok, _} = Visitors.update_nick(visitor.id, "orphan2")
    end
  end
end
