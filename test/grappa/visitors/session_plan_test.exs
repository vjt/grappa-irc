defmodule Grappa.Visitors.SessionPlanTest do
  # async: false — visitor INSERTs + network INSERTs + sqlite
  # contention behavior under full-suite parallelism observed in
  # CP11 S3 (visitors_test.exs same mitigation). Per-test cost
  # negligible (~300ms total).
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Visitors
  alias Grappa.Visitors.SessionPlan

  describe "resolve/1" do
    test "anon visitor → opts with auth_method=:none + visitor subject" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert opts.subject == {:visitor, visitor.id}
      assert opts.subject_label == "visitor:" <> visitor.id
      assert opts.nick == "vjt"
      assert opts.realname == "Grappa Visitor"
      assert opts.sasl_user == "vjt"
      assert opts.auth_method == :none
      assert is_nil(opts.password)
      assert opts.network_slug == "azzurra"
      assert opts.autojoin_channels == []
      assert opts.source_address == nil
    end

    test "carries the picked server's source_address into the plan" do
      network_with_server(slug: "azzurra", port: 6667, source_address: "203.0.113.9")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert opts.source_address == "203.0.113.9"
    end

    test "NULL source server yields source_address: nil in the plan" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert opts.source_address == nil
    end

    test "registered visitor → opts with auth_method=:nickserv_identify + plaintext password" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(visitor.id, "s3cret")

      assert {:ok, opts} = SessionPlan.resolve(registered)
      assert opts.nick == "vjt"
      assert opts.auth_method == :nickserv_identify
      # Cloak EncryptedBinary roundtrip is symmetric — in-memory value
      # after Repo.update is plaintext (the cipher only applies to the
      # bytes on disk in the column). Encryption-at-rest verified via
      # the EncryptedBinary property test, not here.
      assert opts.password == "s3cret"
    end

    test "no enabled server → {:error, :no_server}" do
      _ = network_fixture(slug: "azzurra")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:error, :no_server} = SessionPlan.resolve(visitor)
    end

    test "network slug not configured → {:error, :network_unconfigured}" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "ghosted", "1.2.3.4")

      assert {:error, :network_unconfigured} = SessionPlan.resolve(visitor)
    end

    # CP24 bucket E lifecycle/S1: visitor plans now carry a
    # `credential_failer` callback (closure over `visitor.id`) that
    # `Session.Server.handle_terminal_failure/2` invokes on K-line /
    # permanent SASL. The callback delegates to
    # `Visitors.mark_failed/2` which expires the row immediately so
    # `Bootstrap` stops respawning the rejected visitor.
    test "plan injects credential_failer that expires the visitor on call" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-failer", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert is_function(opts.credential_failer, 1)

      assert :ok = opts.credential_failer.("k-lined: 'no spam'")

      refute Enum.any?(Visitors.list_active(), &(&1.id == visitor.id))
    end

    test "credential_failer no-ops on already-deleted visitor (race tolerance)" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-race", "azzurra", "1.2.3.4")
      assert {:ok, opts} = SessionPlan.resolve(visitor)
      :ok = Visitors.delete(visitor.id)

      assert :ok = opts.credential_failer.("k-lined")
    end

    # Post-zombie-respawn fix (2026-05-27): `refresh_plan` closure
    # subsumes the prior `subject_row_present?` shape. `Session.Server.init/1`
    # calls it on EVERY init (boot + `:transient` restart) and merges
    # the returned plan over the cached opts so DB rotations
    # (`update_nick/2`, `update_last_joined_channels/2`) propagate to
    # live state. `{:error, :not_found}` ends the respawn loop
    # cleanly when the visitor row is gone (operator-delete /
    # Reaper).
    test "plan injects refresh_plan closure that re-resolves from DB on every call" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-gate", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert is_function(opts.refresh_plan, 0)

      # First call: row present, nick matches.
      assert {:ok, fresh1} = opts.refresh_plan.()
      assert fresh1.nick == "vjt-gate"

      # Mutate the row → next call sees the fresh nick.
      assert {:ok, _} = Visitors.update_nick(visitor.id, "vjt-rotated")

      assert {:ok, fresh2} = opts.refresh_plan.()
      assert fresh2.nick == "vjt-rotated"

      # Reaper / operator-delete → `:not_found`.
      :ok = Visitors.delete(visitor.id)
      assert opts.refresh_plan.() == {:error, :not_found}
    end
  end
end
