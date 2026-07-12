defmodule Grappa.Migrations.SeedVisitorEnabledTest do
  @moduledoc """
  #211 phase 3 — the `visitor_enabled` continuity seed migration
  (`20260711130000`). Runs the migration's exact UPDATE SQL against
  seeded networks + visitor credentials and asserts the derive-from-
  reality behavior + idempotency. The SQL is duplicated here (migrations
  stay self-contained per repo convention) — keep it byte-aligned with
  the migration file.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks
  alias Grappa.Networks.Credentials

  @seed_sql """
  UPDATE networks
  SET visitor_enabled = 1
  WHERE visitor_enabled = 0
    AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
  """

  @revert_sql """
  UPDATE networks
  SET visitor_enabled = 0
  WHERE visitor_enabled = 1
    AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
  """

  defp reload(slug), do: Networks.get_network_by_slug!(slug)

  test "enables a network that has visitor credentials" do
    {visitor, network} = visitor_with_network(6667)
    # visitor_with_network → provision write-through created a visitor
    # credential; but the fixture network is not visitor_enabled.
    {:ok, _} = Credentials.upsert_visitor_credential(visitor.id, network.id, %{nick: "seed", auth_method: :none})
    refute reload(network.slug).visitor_enabled

    Repo.query!(@seed_sql, [])

    assert reload(network.slug).visitor_enabled
  end

  test "leaves a network with NO visitor credentials disabled" do
    network = network_fixture(slug: "no-visitors")
    refute reload(network.slug).visitor_enabled

    Repo.query!(@seed_sql, [])

    refute reload(network.slug).visitor_enabled
  end

  test "does not enable a network that only has USER credentials" do
    user = user_fixture()
    network = network_fixture(slug: "users-only")
    _ = credential_fixture(user, network, %{nick: "u"})

    Repo.query!(@seed_sql, [])

    refute reload(network.slug).visitor_enabled
  end

  test "is idempotent — a second run is a no-op" do
    {visitor, network} = visitor_with_network(6667)
    {:ok, _} = Credentials.upsert_visitor_credential(visitor.id, network.id, %{nick: "seed", auth_method: :none})

    Repo.query!(@seed_sql, [])
    Repo.query!(@seed_sql, [])

    assert reload(network.slug).visitor_enabled
  end

  test "down reverses the derived set" do
    {visitor, network} = visitor_with_network(6667)
    {:ok, _} = Credentials.upsert_visitor_credential(visitor.id, network.id, %{nick: "seed", auth_method: :none})

    Repo.query!(@seed_sql, [])
    assert reload(network.slug).visitor_enabled

    Repo.query!(@revert_sql, [])
    refute reload(network.slug).visitor_enabled
  end
end
