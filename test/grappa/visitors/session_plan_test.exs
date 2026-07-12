defmodule Grappa.Visitors.SessionPlanTest do
  # async: false — visitor INSERTs + network INSERTs + sqlite
  # contention behavior under full-suite parallelism observed in
  # CP11 S3 (visitors_test.exs same mitigation). Per-test cost
  # negligible (~300ms total).
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credentials
  alias Grappa.Visitors
  alias Grappa.Visitors.SessionPlan

  # #211 phase 7 — resolve is network-explicit (`resolve/2`) and identity
  # lives on the credential. Every test resolves the network + provisions
  # the visitor's credential on it.
  describe "resolve/2" do
    test "anon visitor → opts with auth_method=:none + visitor subject" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert opts.subject == {:visitor, visitor.id}
      assert opts.subject_label == "visitor:" <> visitor.id
      assert opts.nick == "vjt"
      assert opts.ident == "vjt"
      assert opts.realname == "Grappa Visitor"
      assert opts.sasl_user == "vjt"
      assert opts.auth_method == :none
      assert is_nil(opts.password)
      assert opts.network_slug == "azzurra"
      assert opts.autojoin_channels == []
      assert opts.source_address == nil
    end

    test "visitor with set ident + realname → plan carries them (#152 → per-network)" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)
      {:ok, _} = Credentials.update_credential_identity(cred, %{ident: "grp", realname: "Real Name"})

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert opts.nick == "vjt"
      assert opts.ident == "grp"
      assert opts.realname == "Real Name"
    end

    test "carries the picked server's source_address into the plan" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667, source_address: "203.0.113.9")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert opts.source_address == "203.0.113.9"
    end

    test "NULL source server yields source_address: nil in the plan" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert opts.source_address == nil
    end

    test "registered visitor → opts with auth_method=:nickserv_identify + plaintext password" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, _} = Visitors.commit_password(visitor.id, network.id, "s3cret")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert opts.nick == "vjt"
      assert opts.auth_method == :nickserv_identify
      # Cloak EncryptedBinary roundtrip is symmetric — in-memory value is
      # plaintext (the cipher only applies to the bytes on disk).
      assert opts.password == "s3cret"
    end

    test "no enabled server → {:error, :no_server}" do
      network = network_fixture(slug: "azzurra")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:error, :no_server} = SessionPlan.resolve(visitor, network)
    end

    test "visitor holds no credential on the network → {:error, :network_unconfigured}" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      # A bare visitor with no credential on `network` (provision on a
      # DIFFERENT network so the identity exists but not on this one).
      other = network_fixture(slug: "other-#{System.unique_integer([:positive])}")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", other.slug, "1.2.3.4")

      assert {:error, :network_unconfigured} = SessionPlan.resolve(visitor, network)
    end

    # CP24 bucket E lifecycle/S1: visitor plans carry a `credential_failer`
    # callback that expires the row on K-line / permanent SASL.
    test "plan injects credential_failer that expires the visitor on call" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-failer", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert is_function(opts.credential_failer, 1)

      assert :ok = opts.credential_failer.("k-lined: 'no spam'")
      refute Enum.any?(Visitors.list_active(), &(&1.id == visitor.id))
    end

    test "credential_failer no-ops on already-deleted visitor (race tolerance)" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-race", "azzurra", "1.2.3.4")
      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      :ok = Visitors.delete(visitor.id)

      assert :ok = opts.credential_failer.("k-lined")
    end

    # `refresh_plan` re-resolves the SAME network from the DB on every
    # `Session.Server.init/1` (boot + `:transient` restart), so per-network
    # DB rotations (`update_nick/3`) propagate to live state.
    # `{:error, :not_found}` ends the respawn loop when the identity is gone.
    test "plan injects refresh_plan closure that re-resolves from DB on every call" do
      {network, _} = network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-gate", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor, network)
      assert is_function(opts.refresh_plan, 0)

      assert {:ok, fresh1} = opts.refresh_plan.()
      assert fresh1.nick == "vjt-gate"

      # Mutate the credential nick → next call sees the fresh nick.
      assert {:ok, _} = Visitors.update_nick(visitor.id, network.id, "vjt-rotated")

      assert {:ok, fresh2} = opts.refresh_plan.()
      assert fresh2.nick == "vjt-rotated"

      # Reaper / operator-delete → `:not_found`.
      :ok = Visitors.delete(visitor.id)
      assert opts.refresh_plan.() == {:error, :not_found}
    end
  end
end
