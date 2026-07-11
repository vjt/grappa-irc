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
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.Credential
  alias Grappa.Scrollback.Message

  describe "networks caps" do
    test "max_concurrent_sessions_non_negative rejects -1 (post-U-1: CHECK name unchanged; column renamed)" do
      ts = "2026-05-04T00:00:00Z"

      # The U-1 migration uses ALTER TABLE RENAME COLUMN, which
      # rewrites the CHECK expression but NOT the constraint name.
      # The constraint stays named `max_concurrent_sessions_non_negative`
      # and fires against the renamed column.
      assert_raise Exqlite.Error, ~r/max_concurrent_sessions_non_negative/, fn ->
        Repo.query!(
          "INSERT INTO networks (slug, inserted_at, updated_at, max_concurrent_visitor_sessions) VALUES (?, ?, ?, ?)",
          ["check-test-#{System.unique_integer([:positive])}", ts, ts, -1]
        )
      end
    end

    test "max_per_client_non_negative rejects -5 (#171: CHECK name unchanged; column renamed to max_per_ip)" do
      ts = "2026-05-04T00:00:00Z"

      # The #171 migration uses ALTER TABLE RENAME COLUMN (max_per_client
      # → max_per_ip), which rewrites the CHECK expression but NOT the
      # constraint name. The constraint stays named
      # `max_per_client_non_negative` and fires against the renamed column
      # — same pattern as the U-1 max_concurrent rename above.
      assert_raise Exqlite.Error, ~r/max_per_client_non_negative/, fn ->
        Repo.query!(
          "INSERT INTO networks (slug, inserted_at, updated_at, max_per_ip) VALUES (?, ?, ?, ?)",
          ["check-test-#{System.unique_integer([:positive])}", ts, ts, -5]
        )
      end
    end

    test "visitor + per_client caps accept NULL (the null-cap default)" do
      ts = "2026-05-04T00:00:00Z"

      # max_concurrent_user_sessions is NULL DEFAULT 3 in the
      # post-U-1 schema; omitting the column lets the default apply.
      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO networks (slug, inserted_at, updated_at) VALUES (?, ?, ?)",
                 ["check-test-#{System.unique_integer([:positive])}", ts, ts]
               )
    end

    test "all three caps accept 0 (degenerate lock-down)" do
      ts = "2026-05-04T00:00:00Z"

      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO networks (slug, inserted_at, updated_at, max_concurrent_visitor_sessions, max_concurrent_user_sessions, max_per_ip) VALUES (?, ?, ?, ?, ?, ?)",
                 ["check-test-#{System.unique_integer([:positive])}", ts, ts, 0, 0, 0]
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

      # Read the allowlist through the prod accessor so adding a 6th
      # auth_method that the migration's CHECK doesn't yet cover would
      # red-flag here, not silently slip past.
      for {auth, idx} <-
            Credential.auth_methods()
            |> Enum.map(&Atom.to_string/1)
            |> Enum.with_index() do
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

  describe "network_credentials.subject_xor CHECK (#211)" do
    setup do
      ts = "2026-07-11T00:00:00Z"

      {:ok, user} =
        Accounts.create_user(%{name: "u-#{System.unique_integer([:positive])}", password: "correct horse battery"})

      {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{System.unique_integer([:positive])}"})

      {:ok, visitor} =
        %{nick: "guest", network_slug: network.slug, expires_at: DateTime.add(DateTime.utc_now(), 48, :hour)}
        |> Grappa.Visitors.Visitor.create_changeset()
        |> Repo.insert()

      %{ts: ts, user: user, network: network, visitor: visitor}
    end

    test "rejects a both-null subject raw insert", %{ts: ts, network: network} do
      assert_raise Exqlite.Error, ~r/network_credentials_subject_xor/, fn ->
        Repo.query!(
          "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, inserted_at, updated_at) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?)",
          [network.id, "vjt", "none", "[]", ts, ts]
        )
      end
    end

    test "rejects a both-set subject raw insert", %{ts: ts, user: user, visitor: visitor, network: network} do
      assert_raise Exqlite.Error, ~r/network_credentials_subject_xor/, fn ->
        Repo.query!(
          "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [user.id, visitor.id, network.id, "vjt", "none", "[]", ts, ts]
        )
      end
    end

    test "accepts a visitor-only subject raw insert", %{ts: ts, visitor: visitor, network: network} do
      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, inserted_at, updated_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)",
                 [visitor.id, network.id, "guest", "none", "[]", ts, ts]
               )
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

      # Read the allowlist through the prod accessor so adding an 11th
      # kind that the migration's CHECK doesn't yet cover would red-flag
      # here, not silently slip past.
      kinds = Enum.map(Message.kinds(), &Atom.to_string/1)

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
