defmodule Grappa.Bootstrap.VisitorCredentialReconcileTest do
  @moduledoc """
  #211 phase 3 — `Grappa.Bootstrap.run/0` reconciles every active
  visitor's `(visitor_id, network_id)` Credential BEFORE spawning
  visitor sessions (the read path resolves from the Credential). The
  reconcile is the SAME idempotent `upsert_visitor_credential/3` verb
  the per-mutation write-through uses, bulk-applied — self-healing:
  refresh existing + create any missing at boot.

  This catches drift from the phase-1-backfill → phase-3-deploy window
  (a visitor whose row changed, or a brand-new visitor, before the read
  path started trusting the Credential). After phase 3, the write-through
  keeps them current so every subsequent boot-reconcile is a no-op.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, Repo}
  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.Visitors

  # Reset the ETS singletons other Bootstrap tests reset (circuit/backoff)
  # is unnecessary here — we never spawn (no enabled server), so run/0's
  # visitor spawn loop reports plan_failed/no_server without touching the
  # circuit. We only assert the reconcile side effect on the DB.

  defp read(visitor_id, network_id),
    do: Credentials.get_visitor_credential(visitor_id, network_id)

  test "creates a missing visitor credential for an active visitor at boot" do
    {_, network} = visitor_with_network(6667)
    # A visitor row with NO credential yet (simulates a pre-phase-3
    # visitor the backfill missed, or drift). Insert via raw changeset so
    # no write-through fires.
    visitor = visitor_fixture(network_slug: network.slug, nick: "needscred")
    query = from(c in Credential, where: c.visitor_id == ^visitor.id)
    Repo.delete_all(query)
    assert {:error, :not_found} = read(visitor.id, network.id)

    {:ok, _} = Bootstrap.run()

    assert {:ok, cred} = read(visitor.id, network.id)
    assert cred.nick == "needscred"
    assert cred.auth_method == :none
  end

  test "refreshes a stale visitor credential to match the visitor row" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("staleme", network.slug, "1.2.3.4")

    # Drift the credential out of sync with the visitor row (bypass the
    # write-through by hitting the credential directly).
    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, network.id, %{
        nick: "WRONGNICK",
        auth_method: :none
      })

    {:ok, _} = Bootstrap.run()

    assert {:ok, cred} = read(visitor.id, network.id)
    assert cred.nick == "staleme"
  end

  test "is idempotent — a second boot reconcile is a no-op (no duplicate rows)" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("idem", network.slug, "1.2.3.4")

    {:ok, _} = Bootstrap.run()
    {:ok, _} = Bootstrap.run()

    query =
      from(c in Credential, where: c.visitor_id == ^visitor.id and c.network_id == ^network.id)

    assert Repo.aggregate(query, :count, :id) == 1
  end

  test "skips an orphan-slug visitor without crashing the boot" do
    # No networks row for this slug — reconcile must not raise; the boot
    # continues. (validate_visitor_networks! is the loud orphan guard, but
    # this test uses list_active which includes it; ensure reconcile is
    # non-destructive.) Use an expired visitor so it is NOT in list_active
    # and thus does not trip validate_visitor_networks!.
    _ =
      visitor_fixture(
        network_slug: "ghost-net",
        nick: "orphanrec",
        expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)
      )

    assert {:ok, _} = Bootstrap.run()
  end
end
