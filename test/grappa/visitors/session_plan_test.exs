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
  end
end
