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

    # Operator-delete fail-fast: the `subject_row_present?` closure
    # lets `Session.Server.init/1` bail out cleanly when the visitor
    # row has been removed mid-respawn, preventing the zombie
    # respawn loop class.
    test "plan injects subject_row_present? closure that follows the DB row" do
      network_with_server(slug: "azzurra", port: 6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt-gate", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert is_function(opts.subject_row_present?, 0)

      assert opts.subject_row_present?.() == true

      :ok = Visitors.delete(visitor.id)
      assert opts.subject_row_present?.() == false
    end
  end
end
