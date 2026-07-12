defmodule Grappa.Networks.CredentialXorTest do
  @moduledoc """
  #211 phase 1 — DB-level verification of the `network_credentials`
  subject-XOR promotion.

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

  #211 phase 7 — the `visitor_fixture` now auto-provisions a
  `(visitor, network)` credential when its `:network_slug` resolves. These
  DB-substrate tests insert their OWN credential rows (raw SQL / changeset),
  so they need a BARE visitor with NO auto-credential — `bare_visitor/0`
  inserts a visitor whose slug does not resolve. The phase-1
  `visitor → Credential` backfill describe was DELETED with phase 7: it ran
  the migration's INSERT...SELECT reading the now-dropped `visitors` identity
  scalars (`v.nick`, `v.password_encrypted`, `v.network_slug`, …), which no
  longer exist on the final schema.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credential
  alias Grappa.Repo

  @ts "2026-07-11T12:00:00.000000Z"

  # A BARE visitor row (no auto-credential): pass a slug that does not
  # resolve to a networks row, so `visitor_fixture/1` skips the credential
  # insert. #211 phase 7 — the visitor row is a pure identity/TTL row.
  defp bare_visitor do
    visitor_fixture(network_slug: "unbound-#{System.unique_integer([:positive])}")
  end

  describe "subject XOR CHECK at the DB (defense-in-depth)" do
    setup do
      user = user_fixture()
      network = network_fixture()
      visitor = bare_visitor()
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
      visitor = bare_visitor()
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
      # Distinct nicks so ONLY the (visitor_id, network_id) uniqueness can
      # fire — the same nick would ALSO trip the phase-4b folded-nick index
      # (see the dedicated describe below), and SQLite would report whichever
      # index it checks first. This test isolates the per-(visitor, network)
      # guard: a visitor gets exactly one credential per network regardless
      # of nick.
      first = %{visitor_id: visitor.id, network_id: network.id, nick: "guest", auth_method: :none}
      assert {:ok, _} = %Credential{} |> Credential.changeset(first) |> Repo.insert()

      second = %{visitor_id: visitor.id, network_id: network.id, nick: "guest2", auth_method: :none}
      assert {:error, cs} = %Credential{} |> Credential.changeset(second) |> Repo.insert()
      refute cs.valid?
      assert "credential already exists for this (visitor, network)" in errors_on(cs).visitor_id
    end
  end

  # #211 phase 4b — the credential-side folded-nick partial unique index
  # `(fold(nick), network_id) WHERE visitor_id IS NOT NULL`. This is the
  # per-network identity guard for VISITOR credentials (GH #121) — phase 7
  # dropped the visitors-table twin, so this is now the sole folded-nick
  # uniqueness guard for visitor identities.
  describe "visitor folded-nick uniqueness (phase-4b, GH #121)" do
    setup do
      network = network_fixture()
      v1 = bare_visitor()
      v2 = bare_visitor()
      %{network: network, v1: v1, v2: v2}
    end

    test "two DIFFERENT visitors cannot hold the same nick on one network", %{
      network: network,
      v1: v1,
      v2: v2
    } do
      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v1.id,
                 network_id: network.id,
                 nick: "mezmerize",
                 auth_method: :none
               })
               |> Repo.insert()

      assert {:error, cs} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v2.id,
                 network_id: network.id,
                 nick: "mezmerize",
                 auth_method: :none
               })
               |> Repo.insert()

      refute cs.valid?
      assert "nick already taken on this network" in errors_on(cs).nick
    end

    test "the collision is rfc1459-folded (Mezmerize == mezmerize == nick[1]/nick{1})", %{
      network: network,
      v1: v1,
      v2: v2
    } do
      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v1.id,
                 network_id: network.id,
                 nick: "Mez[1]",
                 auth_method: :none
               })
               |> Repo.insert()

      # `[` folds to `{` under rfc1459 — a different display case + a
      # bracket variant is the SAME identity, so this must collide.
      assert {:error, cs} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v2.id,
                 network_id: network.id,
                 nick: "mez{1}",
                 auth_method: :none
               })
               |> Repo.insert()

      refute cs.valid?
      assert "nick already taken on this network" in errors_on(cs).nick
    end

    test "the SAME visitor may hold the same folded nick on TWO networks (accretion)", %{
      v1: v1
    } do
      net_a = network_fixture()
      net_b = network_fixture()

      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v1.id,
                 network_id: net_a.id,
                 nick: "spanner",
                 auth_method: :none
               })
               |> Repo.insert()

      # Different network → the folded uniqueness is per-(nick, network),
      # so accreting the same nick onto a second network is allowed.
      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v1.id,
                 network_id: net_b.id,
                 nick: "spanner",
                 auth_method: :none
               })
               |> Repo.insert()
    end

    test "a USER credential and a visitor credential can share a nick on one network", %{
      network: network,
      v1: v1
    } do
      user = user_fixture()

      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 visitor_id: v1.id,
                 network_id: network.id,
                 nick: "shared",
                 auth_method: :none
               })
               |> Repo.insert()

      # The folded index is partial (`WHERE visitor_id IS NOT NULL`), so a
      # user credential with the same nick does NOT collide — users are a
      # separate identity space (operator-bound), guarded independently.
      assert {:ok, _} =
               %Credential{}
               |> Credential.changeset(%{
                 user_id: user.id,
                 network_id: network.id,
                 nick: "shared",
                 auth_method: :none
               })
               |> Repo.insert()
    end
  end

  describe "visitor credential Cloak round-trip" do
    test "password_encrypted persists + reloads as plaintext via the vault" do
      network = network_fixture()
      visitor = bare_visitor()

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
end
