defmodule Grappa.Visitors.SessionPlanCutoverTest do
  @moduledoc """
  #211 phase 3 — proves `Grappa.Visitors.SessionPlan.resolve/1` reads
  the visitor's `(visitor_id, network_id)` **Credential** for identity,
  not the raw `%Visitor{}` columns. The out-of-band credential mutation
  below would be invisible pre-cutover (resolver read the visitor row);
  post-cutover the plan reflects the Credential.

  The behavior-neutral characterization lock stays in
  `session_plan_test.exs` (unchanged) — those assertions still pass
  because the write-through keeps the Credential == the visitor row.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credentials
  alias Grappa.Visitors
  alias Grappa.Visitors.SessionPlan

  test "resolve/1 reads identity from the Credential, not the visitor row" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("orig", network.slug, "1.2.3.4")

    # Divergence the pre-cutover resolver could never see: mutate ONLY
    # the credential, leave the visitor row's nick/ident alone.
    {:ok, _} =
      Credentials.upsert_visitor_credential(visitor.id, network.id, %{
        nick: "crednick",
        ident: "credident",
        realname: "Cred Real",
        auth_method: :none
      })

    assert {:ok, opts} = SessionPlan.resolve(visitor)
    assert opts.nick == "crednick"
    assert opts.ident == "credident"
    assert opts.realname == "Cred Real"
    assert opts.subject == {:visitor, visitor.id}
    assert opts.subject_label == "visitor:" <> visitor.id
  end

  test "resolve/1 self-heals a missing credential from the visitor row" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("healme", network.slug, "1.2.3.4")

    # Simulate drift: the credential vanished (a logged sync failure, a
    # pre-phase-3 visitor that never got reconciled). resolve must not
    # crash — it re-derives the credential from the visitor row.
    query = from(c in Grappa.Networks.Credential, where: c.visitor_id == ^visitor.id)
    Repo.delete_all(query)

    assert {:ok, opts} = SessionPlan.resolve(visitor)
    assert opts.nick == "healme"
    # And the credential now exists again (self-healed).
    assert {:ok, _} = Credentials.get_visitor_credential(visitor.id, network.id)
  end

  test "registered visitor: plan carries nickserv_identify + password from the Credential" do
    {_, network} = visitor_with_network(6667)
    {:ok, visitor} = Visitors.find_or_provision_anon("reg", network.slug, "1.2.3.4")
    {:ok, _} = Visitors.commit_password(visitor.id, "pw123")

    assert {:ok, opts} = SessionPlan.resolve(visitor)
    assert opts.auth_method == :nickserv_identify
    assert opts.password == "pw123"
  end
end
