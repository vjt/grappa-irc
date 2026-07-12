defmodule Grappa.Migrations.SeedVisitorAutoconnectTest do
  @moduledoc """
  #211 phase 6 — the `visitor_autoconnect` continuity seed migration
  (`20260712120100`). Runs the migration's exact UPDATE SQL against
  seeded networks + visitor credentials and asserts the derive-from-
  reality behavior + the `visitor_enabled = 1` subset conjunct +
  idempotency. The SQL is duplicated here (migrations stay
  self-contained per repo convention) — keep it byte-aligned with the
  migration file.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks
  alias Grappa.Networks.Credentials

  @seed_sql """
  UPDATE networks
  SET visitor_autoconnect = 1
  WHERE visitor_autoconnect = 0
    AND visitor_enabled = 1
    AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
  """

  @revert_sql """
  UPDATE networks
  SET visitor_autoconnect = 0
  WHERE visitor_autoconnect = 1
    AND visitor_enabled = 1
    AND id IN (SELECT DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT NULL)
  """

  defp reload(slug), do: Networks.get_network_by_slug!(slug)

  defp visitor_enabled_network(slug) do
    {:ok, net} = Networks.create_network(%{slug: slug, visitor_enabled: true})
    net
  end

  test "enables autoconnect for a visitor_enabled network with visitor credentials" do
    {visitor, _} = visitor_with_network(6667)
    net = visitor_enabled_network("vac-seed-on")

    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, net.id, %{
        nick: "seed",
        auth_method: :none
      })

    refute reload(net.slug).visitor_autoconnect

    Repo.query!(@seed_sql, [])

    assert reload(net.slug).visitor_autoconnect
  end

  test "does NOT enable a network that has visitor credentials but is NOT visitor_enabled" do
    # The `visitor_enabled = 1` conjunct — a disabled network with
    # visitor creds is never auto-connected (subset invariant).
    {visitor, network} = visitor_with_network(6667)

    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, network.id, %{
        nick: "seed",
        auth_method: :none
      })

    refute reload(network.slug).visitor_enabled

    Repo.query!(@seed_sql, [])

    refute reload(network.slug).visitor_autoconnect
  end

  test "leaves a visitor_enabled network with NO visitor credentials off" do
    net = visitor_enabled_network("vac-seed-empty")
    refute reload(net.slug).visitor_autoconnect

    Repo.query!(@seed_sql, [])

    refute reload(net.slug).visitor_autoconnect
  end

  test "does not enable a network that only has USER credentials" do
    user = user_fixture()
    net = visitor_enabled_network("vac-users-only")
    _ = credential_fixture(user, net, %{nick: "u"})

    Repo.query!(@seed_sql, [])

    refute reload(net.slug).visitor_autoconnect
  end

  test "is idempotent — a second run is a no-op" do
    {visitor, _} = visitor_with_network(6667)
    net = visitor_enabled_network("vac-seed-idem")

    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, net.id, %{
        nick: "seed",
        auth_method: :none
      })

    Repo.query!(@seed_sql, [])
    Repo.query!(@seed_sql, [])

    assert reload(net.slug).visitor_autoconnect
  end

  test "down reverses the derived set" do
    {visitor, _} = visitor_with_network(6667)
    net = visitor_enabled_network("vac-seed-down")

    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, net.id, %{
        nick: "seed",
        auth_method: :none
      })

    Repo.query!(@seed_sql, [])
    assert reload(net.slug).visitor_autoconnect

    Repo.query!(@revert_sql, [])
    refute reload(net.slug).visitor_autoconnect
  end
end
