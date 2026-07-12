defmodule Grappa.Visitors.CredentialWriteThroughTest do
  @moduledoc """
  #211 phase 3/7 — every visitor identity mutation writes to the visitor's
  `(visitor_id, network_id)` Credential, because the Credential IS the
  identity source of truth (the read path
  `Grappa.Visitors.SessionPlan.resolve/2` resolves from it, and the visitor
  row is a pure identity/TTL row post-phase-7).

  Proves a NEW visitor created post-cutover gets a correct Credential with
  NO separate backfill run (the provision itself writes it).
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

  describe "commit_password/3" do
    test "promotes the Credential to nickserv_identify with the password" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("pwvis", network.slug, "1.2.3.4")

      {:ok, _} = Visitors.commit_password(visitor.id, network.id, "topsecret")

      assert {:ok, cred} = read(visitor, network)
      assert cred.auth_method == :nickserv_identify
      assert Credential.upstream_password(cred) == "topsecret"
    end
  end

  describe "rotate_password/3" do
    test "rotates the Credential password for an already-registered visitor" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("rotvis", network.slug, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(visitor.id, network.id, "first")

      {:ok, _} = Visitors.rotate_password(visitor.id, network.id, "second")

      assert {:ok, cred} = read(visitor, network)
      assert cred.auth_method == :nickserv_identify
      assert Credential.upstream_password(cred) == "second"
    end
  end

  describe "update_nick/3" do
    test "rotates the Credential nick" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("oldn", network.slug, "1.2.3.4")

      {:ok, _} = Visitors.update_nick(visitor.id, network.id, "newn")

      assert {:ok, cred} = read(visitor, network)
      assert cred.nick == "newn"
      # #211 phase 7 — update_nick routes through the narrow
      # identity_changeset (nick only); sasl_user is NOT re-derived.
      assert cred.sasl_user == "oldn"
    end
  end

  describe "Credentials.update_credential_identity/2 (per-network identity edit)" do
    test "writes ident + realname onto the Credential" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("idvis", network.slug, "1.2.3.4")
      {:ok, cred} = read(visitor, network)

      {:ok, _} = Credentials.update_credential_identity(cred, %{ident: "myident", realname: "My Real"})

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
      {:ok, rep} = Credentials.representative_visitor_credential(visitor.id)

      # Accrete B: a second credential on the SAME visitor identity.
      {net_b, _} = network_with_server(port: 6668, slug: "beta-chan", visitor_enabled: true)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: rep.nick,
          sasl_user: rep.nick,
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

    test "a per-network nick-change does NOT clobber that network's channel set" do
      {_, net_a} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("syncvis", net_a.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, net_a.id, ["#kept"])

      # A nick mutation on the credential must NOT reset the credential's
      # per-network channel list (identity edits touch only nick/ident/
      # realname via the narrow identity_changeset).
      {:ok, _} = Visitors.update_nick(visitor.id, net_a.id, "syncvis2")

      assert Visitors.list_autojoin_channels(visitor, net_a.id) == ["#kept"]
    end
  end
end
