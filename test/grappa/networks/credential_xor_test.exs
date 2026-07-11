defmodule Grappa.Networks.CredentialXorTest do
  @moduledoc """
  #211 phase 1 — DB-level verification of the `network_credentials`
  subject-XOR promotion + the visitor→Credential backfill.

  Complements the schema-changeset tests in
  `Grappa.Networks.CredentialTest` (which cover the Elixir-layer
  `validate_subject_xor/1`). This module pokes the DB directly to prove
  the substrate enforces what the changeset promises:

    * the `network_credentials_subject_xor` CHECK fires on a raw
      both-null / both-set insert that bypasses the changeset,
    * the two partial unique indexes enforce per-subject uniqueness
      independently (a user row and a visitor row on the same network
      do NOT collide),
    * a visitor credential persists + reloads with its Cloak-encrypted
      password intact.

  It also exercises the backfill SQL end-to-end against seeded
  old-shape visitor rows (the migration ran once at suite setup; the
  test re-runs the same idempotent INSERT and asserts correctness +
  no-op-on-rerun).
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credential
  alias Grappa.{Repo, Visitors}

  @ts "2026-07-11T12:00:00.000000Z"

  describe "subject XOR CHECK at the DB (defense-in-depth)" do
    setup do
      user = user_fixture()
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug)
      %{user: user, network: network, visitor: visitor}
    end

    test "rejects a both-null raw insert", %{network: network} do
      assert_raise Exqlite.Error, ~r/network_credentials_subject_xor/, fn ->
        Repo.query!(
          "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, last_joined_channels, connection_state, inserted_at, updated_at) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
          [network.id, "vjt", "none", "[]", "[]", "connected", @ts, @ts]
        )
      end
    end

    test "rejects a both-set raw insert", %{user: user, visitor: visitor, network: network} do
      assert_raise Exqlite.Error, ~r/network_credentials_subject_xor/, fn ->
        Repo.query!(
          "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, last_joined_channels, connection_state, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [user.id, visitor.id, network.id, "vjt", "none", "[]", "[]", "connected", @ts, @ts]
        )
      end
    end

    test "accepts a user-only raw insert", %{user: user, network: network} do
      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, last_joined_channels, connection_state, inserted_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
                 [user.id, network.id, "vjt", "none", "[]", "[]", "connected", @ts, @ts]
               )
    end

    test "accepts a visitor-only raw insert", %{visitor: visitor, network: network} do
      assert {:ok, _} =
               Repo.query(
                 "INSERT INTO network_credentials (user_id, visitor_id, network_id, nick, auth_method, autojoin_channels, last_joined_channels, connection_state, inserted_at, updated_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 [visitor.id, network.id, "guest", "none", "[]", "[]", "connected", @ts, @ts]
               )
    end
  end

  describe "partial unique indexes (per-subject uniqueness)" do
    setup do
      user = user_fixture()
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug)
      %{user: user, network: network, visitor: visitor}
    end

    test "a user and a visitor credential coexist on the same network", %{
      user: user,
      visitor: visitor,
      network: network
    } do
      # If the uniqueness were NOT partial (i.e. included NULL pairs),
      # these two rows would spuriously collide. They must both insert.
      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 user_id: user.id,
                 network_id: network.id,
                 nick: "vjt",
                 auth_method: :none
               })
               |> Repo.insert()

      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: visitor.id,
                 network_id: network.id,
                 nick: "guest",
                 auth_method: :none
               })
               |> Repo.insert()
    end

    test "a second visitor credential for the same (visitor, network) is a changeset error", %{
      visitor: visitor,
      network: network
    } do
      attrs = %{visitor_id: visitor.id, network_id: network.id, nick: "guest", auth_method: :none}
      assert {:ok, _} = %Credential{} |> Credential.changeset(attrs) |> Repo.insert()

      assert {:error, cs} = %Credential{} |> Credential.changeset(attrs) |> Repo.insert()
      refute cs.valid?
      assert "credential already exists for this (visitor, network)" in errors_on(cs).visitor_id
    end
  end

  describe "visitor credential Cloak round-trip" do
    test "password_encrypted persists + reloads as plaintext via the vault" do
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug)

      {:ok, inserted} =
        %Credential{}
        |> Credential.changeset(%{
          visitor_id: visitor.id,
          network_id: network.id,
          nick: "guest",
          auth_method: :nickserv_identify,
          password: "hunter2"
        })
        |> Repo.insert()

      reloaded = Repo.get_by(Credential, visitor_id: visitor.id, network_id: network.id)
      # Cloak decrypts on load — the in-memory field carries plaintext.
      assert Credential.upstream_password(reloaded) == "hunter2"
      assert reloaded.id == inserted.id
      refute is_nil(reloaded.id)
    end
  end

  describe "backfill: visitor -> synthetic Credential" do
    # Runs the migration's exact INSERT SQL against seeded old-shape
    # visitors, then asserts the derived Credential + idempotency. The
    # SQL is duplicated here rather than imported (migrations stay
    # self-contained per repo convention) — keep it byte-aligned with
    # `20260711125000_backfill_visitor_credentials.exs`.
    @backfill_sql """
    INSERT INTO network_credentials
      (visitor_id, user_id, network_id, nick, ident, realname, sasl_user,
       password_encrypted, auth_method, autojoin_channels, last_joined_channels,
       connection_state, inserted_at, updated_at)
    SELECT
      v.id, NULL, n.id, v.nick, v.ident, v.realname, v.nick,
      v.password_encrypted,
      CASE WHEN v.password_encrypted IS NOT NULL THEN 'nickserv_identify' ELSE 'none' END,
      '[]', COALESCE(v.last_joined_channels, '[]'), 'connected',
      v.inserted_at, v.updated_at
    FROM visitors v
    JOIN networks n ON n.slug = v.network_slug
    WHERE NOT EXISTS (
      SELECT 1 FROM network_credentials nc
      WHERE nc.visitor_id = v.id AND nc.network_id = n.id
    )
    """

    test "anon visitor -> one auth_method=:none credential" do
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug, nick: "anon1")

      Repo.query!(@backfill_sql, [])

      cred = Repo.get_by!(Credential, visitor_id: visitor.id, network_id: network.id)
      assert cred.nick == "anon1"
      assert cred.auth_method == :none
      assert cred.sasl_user == "anon1"
      assert cred.connection_state == :connected
      assert is_nil(cred.user_id)
      assert is_nil(Credential.upstream_password(cred))
    end

    test "NickServ-identified visitor -> :nickserv_identify + ciphertext byte-fidelity" do
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug, nick: "identd1")
      {:ok, _} = Visitors.commit_password(visitor.id, "s3cret-pw")

      # #211 phase 3 — `commit_password/2` now write-throughs a Credential
      # (re-encrypting via the changeset → a fresh AES-GCM IV). This test
      # exercises the PHASE-1 migration's RAW byte-copy in isolation, which
      # requires the migration's precondition: a visitor with NO credential
      # yet. Clear the write-through credential so `@backfill_sql`'s
      # `WHERE NOT EXISTS` actually performs the copy under test.
      visitor_creds = from(c in Credential, where: not is_nil(c.visitor_id))
      Repo.delete_all(visitor_creds)

      # Grab the raw stored ciphertext BEFORE the backfill copies it.
      # binary_id is stored as a TEXT UUID string in sqlite (same as the
      # existing check_constraints_test raw inserts), so pass v.id directly.
      %{rows: [[visitor_ct]]} =
        Repo.query!("SELECT password_encrypted FROM visitors WHERE id = ?", [visitor.id])

      Repo.query!(@backfill_sql, [])

      %{rows: [[cred_ct]]} =
        Repo.query!(
          "SELECT password_encrypted FROM network_credentials WHERE visitor_id = ? AND network_id = ?",
          [visitor.id, network.id]
        )

      # Raw ciphertext bytes are byte-identical (no decrypt/re-encrypt).
      assert cred_ct == visitor_ct
      refute is_nil(cred_ct)

      cred = Repo.get_by!(Credential, visitor_id: visitor.id, network_id: network.id)
      assert cred.auth_method == :nickserv_identify
      # And the same vault decrypts the copied bytes back to plaintext.
      assert Credential.upstream_password(cred) == "s3cret-pw"
    end

    test "last_joined_channels carries onto the credential" do
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug, nick: "joiner")
      _ = visitor_channel_fixture(visitor, "#grappa")

      # #211 phase 3 — clear the write-through Credential so the phase-1
      # migration under test performs the insert (see the byte-fidelity
      # test above for the rationale).
      visitor_creds = from(c in Credential, where: not is_nil(c.visitor_id))
      Repo.delete_all(visitor_creds)

      Repo.query!(@backfill_sql, [])

      cred = Repo.get_by!(Credential, visitor_id: visitor.id, network_id: network.id)
      assert "#grappa" in cred.last_joined_channels
    end

    test "is idempotent — re-running creates no duplicate" do
      network = network_fixture()
      visitor = visitor_fixture(network_slug: network.slug, nick: "once")

      Repo.query!(@backfill_sql, [])
      Repo.query!(@backfill_sql, [])
      Repo.query!(@backfill_sql, [])

      query = from(c in Credential, where: c.visitor_id == ^visitor.id and c.network_id == ^network.id)
      count = Repo.aggregate(query, :count, :id)

      assert count == 1
    end

    test "orphan-slug visitor is skipped, not crashed, and left untouched" do
      # A visitor whose network_slug has no networks row. The JOIN drops
      # it — no credential, no error, visitor row intact.
      visitor = visitor_fixture(network_slug: "nonexistent-net", nick: "orphan")

      assert {:ok, _} = Repo.query(@backfill_sql, [])

      query = from(c in Credential, where: c.visitor_id == ^visitor.id)
      count = Repo.aggregate(query, :count, :id)

      assert count == 0
      # Visitor row survives unchanged.
      assert Repo.get(Visitors.Visitor, visitor.id).nick == "orphan"
    end
  end
end
