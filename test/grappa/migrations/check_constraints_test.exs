defmodule Grappa.Migrations.CheckConstraintsTest do
  @moduledoc """
  Verifies the DB-level CHECK constraints added by
  `20260504020002_check_constraints_caps_auth_method_messages_kind.exs`
  actually fire on out-of-allowlist raw inserts (defense-in-depth
  against raw-SQL drift past the changeset boundary).

  Each test pokes `Repo.query!/2` directly with a value the schema
  layer's `validate_change` / `Ecto.Enum` would normally catch, and
  asserts sqlite raises an `Exqlite.Error` whose message names the
  expected CHECK constraint. If a future schema change ever drops
  one of these CHECKs without a deliberate migration, these tests
  red-flag it.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Networks}

  describe "networks caps" do
    test "max_concurrent_sessions_non_negative rejects -1" do
      ts = "2026-05-04T00:00:00Z"

      assert_raise Exqlite.Error, ~r/max_concurrent_sessions_non_negative/, fn ->
        Repo.query!(
          "INSERT INTO networks (slug, inserted_at, updated_at, max_concurrent_sessions) VALUES (?, ?, ?, ?)",
          ["check-test-#{System.unique_integer([:positive])}", ts, ts, -1]
        )
      end
    end

    test "max_per_client_non_negative rejects -5" do
      ts = "2026-05-04T00:00:00Z"

      assert_raise Exqlite.Error, ~r/max_per_client_non_negative/, fn ->
        Repo.query!(
          "INSERT INTO networks (slug, inserted_at, updated_at, max_per_client) VALUES (?, ?, ?, ?)",
          ["check-test-#{System.unique_integer([:positive])}", ts, ts, -5]
        )
      end
    end

    test "both caps accept NULL (the null-cap default)" do
      ts = "2026-05-04T00:00:00Z"

      # Sanity check that NULL passes — the CHECK is "IS NULL OR >= 0".
      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO networks (slug, inserted_at, updated_at) VALUES (?, ?, ?)",
                 ["check-test-#{System.unique_integer([:positive])}", ts, ts]
               )
    end

    test "both caps accept 0 (degenerate lock-down)" do
      ts = "2026-05-04T00:00:00Z"

      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO networks (slug, inserted_at, updated_at, max_concurrent_sessions, max_per_client) VALUES (?, ?, ?, ?, ?)",
                 ["check-test-#{System.unique_integer([:positive])}", ts, ts, 0, 0]
               )
    end
  end

  describe "network_credentials.auth_method enum" do
    test "auth_method_enum rejects an unknown atom string" do
      ts = "2026-05-04T00:00:00Z"

      {:ok, user} =
        Accounts.create_user(%{name: "u-#{System.unique_integer([:positive])}", password: "correct horse battery"})

      {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{System.unique_integer([:positive])}"})

      assert_raise Exqlite.Error, ~r/auth_method_enum/, fn ->
        Repo.query!(
          "INSERT INTO network_credentials (user_id, network_id, nick, auth_method, autojoin_channels, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [user.id, network.id, "vjt", "totally_bogus", "[]", ts, ts]
        )
      end
    end

    test "auth_method_enum accepts every documented atom in the allowlist" do
      ts = "2026-05-04T00:00:00Z"

      {:ok, user} =
        Accounts.create_user(%{name: "u-#{System.unique_integer([:positive])}", password: "correct horse battery"})

      for {auth, idx} <-
            Enum.with_index(["auto", "sasl", "server_pass", "nickserv_identify", "none"]) do
        {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{idx}-#{System.unique_integer([:positive])}"})

        assert {:ok, _} =
                 Repo.query(
                   "INSERT INTO network_credentials (user_id, network_id, nick, auth_method, autojoin_channels, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [user.id, network.id, "vjt", auth, "[]", ts, ts]
                 ),
               "auth_method=#{auth} should pass the CHECK"
      end
    end
  end

  describe "messages.kind enum" do
    test "kind_enum rejects an unknown atom string" do
      ts = "2026-05-04T00:00:00Z"

      {:ok, user} =
        Accounts.create_user(%{name: "u-#{System.unique_integer([:positive])}", password: "correct horse battery"})

      {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{System.unique_integer([:positive])}"})

      assert_raise Exqlite.Error, ~r/kind_enum/, fn ->
        Repo.query!(
          "INSERT INTO messages (channel, server_time, kind, sender, body, meta, inserted_at, network_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ["#x", 0, "totally_bogus", "vjt", "ciao", "{}", ts, network.id, user.id]
        )
      end
    end

    test "kind_enum accepts every documented kind in the allowlist" do
      ts = "2026-05-04T00:00:00Z"

      {:ok, user} =
        Accounts.create_user(%{name: "u-#{System.unique_integer([:positive])}", password: "correct horse battery"})

      {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{System.unique_integer([:positive])}"})

      # Mirrors `Grappa.Scrollback.Message.@kinds`.
      kinds = ~w[privmsg notice action join part quit nick_change mode topic kick]

      for kind <- kinds do
        assert {:ok, _} =
                 Repo.query(
                   "INSERT INTO messages (channel, server_time, kind, sender, body, meta, inserted_at, network_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   ["#x", 0, kind, "vjt", "ciao", "{}", ts, network.id, user.id]
                 ),
               "kind=#{kind} should pass the CHECK"
      end
    end
  end
end
