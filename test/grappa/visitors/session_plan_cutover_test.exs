defmodule Grappa.Visitors.SessionPlanCutoverTest do
  @moduledoc """
  #211 phase 3/7 — proves `Grappa.Visitors.SessionPlan.resolve/2` reads
  the visitor's `(visitor_id, network_id)` **Credential** for identity,
  not the raw `%Visitor{}` columns (which no longer exist post-phase-7).
  The out-of-band credential mutation below would be invisible pre-cutover
  (resolver read the visitor row); post-cutover the plan reflects the
  Credential.

  The behavior-neutral characterization lock stays in
  `session_plan_test.exs` (unchanged).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credentials
  alias Grappa.Visitors
  alias Grappa.Visitors.SessionPlan

  test "resolve/2 reads identity from the Credential, not the visitor row" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("orig", network.slug, "1.2.3.4")

    # Divergence the pre-cutover resolver could never see: mutate the
    # credential's identity fields.
    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, network.id, %{
        nick: "crednick",
        ident: "credident",
        realname: "Cred Real",
        auth_method: :none
      })

    assert {:ok, opts} = SessionPlan.resolve(visitor, network)
    assert opts.nick == "crednick"
    assert opts.ident == "credident"
    assert opts.realname == "Cred Real"
    assert opts.subject == {:visitor, visitor.id}
    assert opts.subject_label == "visitor:" <> visitor.id
  end

  test "resolve/2 returns :network_unconfigured when the visitor holds no credential" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("nocred", network.slug, "1.2.3.4")

    # #211 phase 7 — the credential IS the identity source of truth now;
    # there is nothing to self-heal from the (pure identity/TTL) visitor
    # row. A missing credential is a genuine `:network_unconfigured`.
    query = from(c in Grappa.Networks.Credential, where: c.visitor_id == ^visitor.id)
    Repo.delete_all(query)

    assert {:error, :network_unconfigured} = SessionPlan.resolve(visitor, network)
  end

  test "registered visitor: plan carries nickserv_identify + password from the Credential" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("reg", network.slug, "1.2.3.4")
    {:ok, _} = Visitors.commit_password(visitor.id, network.id, "pw123")

    assert {:ok, opts} = SessionPlan.resolve(visitor, network)
    assert opts.auth_method == :nickserv_identify
    assert opts.password == "pw123"
  end
end
