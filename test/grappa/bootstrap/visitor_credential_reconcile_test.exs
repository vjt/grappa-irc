defmodule Grappa.Bootstrap.VisitorCredentialReconcileTest do
  @moduledoc """
  #211 phase 7 — `Grappa.Bootstrap.run/0` and the visitor credential.

  Pre-phase-7 Bootstrap reconciled every active visitor's
  `(visitor_id, network_id)` Credential FROM the visitor row's identity
  scalars (create-missing + refresh-stale). Phase 7 dropped those scalars:
  the credential IS the identity source of truth, so there is nothing to
  reconcile FROM. The two reconcile tests ("creates a missing credential",
  "refreshes a stale credential") were DELETED — they encoded behavior that
  no longer exists.

  What remains true: a boot on an already-provisioned visitor is a no-op
  (no duplicate rows), and a credential-less / orphan-slug visitor never
  crashes the boot.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, Repo}
  alias Grappa.Networks.Credential
  alias Grappa.Visitors

  test "is idempotent — a second boot is a no-op (no duplicate credential rows)" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("idem", network.slug, "1.2.3.4")

    {:ok, _} = Bootstrap.run()
    {:ok, _} = Bootstrap.run()

    query =
      from(c in Credential, where: c.visitor_id == ^visitor.id and c.network_id == ^network.id)

    assert Repo.aggregate(query, :count, :id) == 1
  end

  test "skips a credential-less visitor without crashing the boot" do
    # An expired bare visitor whose slug does not resolve → no credential.
    # It is NOT in list_active (expired), and even if it were, a
    # credential-less visitor is skipped (logged), never fatal.
    _ =
      visitor_fixture(
        network_slug: "ghost-net",
        nick: "orphanrec",
        expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)
      )

    assert {:ok, _} = Bootstrap.run()
  end
end
