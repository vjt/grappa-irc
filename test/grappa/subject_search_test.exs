defmodule Grappa.SubjectSearchTest do
  @moduledoc """
  #257 — the admin subject-search context: ONE unified search over BOTH
  subject kinds (users + visitors), returning a tagged-union `Result`
  list keyed on the closed set `:user | :visitor`.

  Each leg is scoped to its own subject column (users via `Accounts`,
  visitors via the `visitor_id IS NOT NULL` credential path) so the union
  never NOT-IN-poisons across the polymorphic FK
  ([[feedback_not_in_null_poisoning_polymorphic_subquery]]). The stable
  key is the user id / visitor id — NEVER the nick (a visitor is
  multi-network, so a nick is not a stable key, #257).

  ## Test isolation

  `async: true` — every test scopes to freshly-created rows through the
  Repo sandbox.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credentials
  alias Grappa.SubjectSearch
  alias Grappa.SubjectSearch.{AdminWire, Result}

  describe "search/2" do
    test "a user-only match returns a :user result with a nil network + the account name as nick" do
      user = user_fixture(name: "useronly257")

      assert [%Result{type: :user, id: id, network: nil, nick: "useronly257"}] =
               SubjectSearch.search("useronly257", 20)

      assert id == user.id
    end

    test "a visitor-only match returns a :visitor result with network slug + per-network nick" do
      {visitor, network} = visitor_with_network(7201)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "vguest257",
          auth_method: :none
        })

      assert [%Result{type: :visitor, id: id, network: slug, nick: "vguest257"}] =
               SubjectSearch.search("vguest257", 20)

      assert id == visitor.id
      assert slug == network.slug
    end

    test "the visitor result id is the stable visitor id, not the nick" do
      {visitor, network} = visitor_with_network(7202)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "stablekey257",
          auth_method: :none
        })

      assert [%Result{id: id}] = SubjectSearch.search("stablekey257", 20)
      assert id == visitor.id
      refute id == "stablekey257"
    end

    test "a multi-network visitor with the same nick yields one row per network" do
      {visitor, net_a} = visitor_with_network(7203)
      net_b = network_fixture()

      for net <- [net_a, net_b] do
        {:ok, _} =
          Credentials.upsert_visitor_credential(visitor.id, net.id, %{
            nick: "multinet257",
            sasl_user: "multinet257",
            auth_method: :none
          })
      end

      results = SubjectSearch.search("multinet257", 20)

      assert length(results) == 2
      assert Enum.all?(results, &(&1.type == :visitor and &1.id == visitor.id))
      slugs = results |> Enum.map(& &1.network) |> Enum.sort()
      assert slugs == Enum.sort([net_a.slug, net_b.slug])
    end

    test "matches both a user and a visitor, users first" do
      user = user_fixture(name: "twinsubj257")
      {visitor, network} = visitor_with_network(7204)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "twinsubj257",
          auth_method: :none
        })

      results = SubjectSearch.search("twinsubj257", 20)

      assert Enum.map(results, & &1.type) == [:user, :visitor]
      assert Enum.map(results, & &1.id) == [user.id, visitor.id]
    end

    test "folds the visitor nick (rfc1459, GH #121) — uppercase query matches" do
      {visitor, network} = visitor_with_network(7205)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "casefold257",
          auth_method: :none
        })

      assert [%Result{type: :visitor}] = SubjectSearch.search("CASEFOLD257", 20)
    end

    test "no match returns []" do
      _ = user_fixture(name: "present257")
      assert SubjectSearch.search("zzz-absent-257", 20) == []
    end

    test "a blank query returns []" do
      _ = user_fixture(name: "present257")
      assert SubjectSearch.search("", 20) == []
      assert SubjectSearch.search("   ", 20) == []
    end

    test "honours the combined limit across both legs" do
      for n <- 1..2, do: user_fixture(name: "combo257u#{n}")
      {visitor, net_a} = visitor_with_network(7206)
      net_b = network_fixture()

      for net <- [net_a, net_b] do
        {:ok, _} =
          Credentials.upsert_visitor_credential(visitor.id, net.id, %{
            nick: "combo257v",
            sasl_user: "combo257v",
            auth_method: :none
          })
      end

      # 2 users + 2 visitor rows match; limit 3 clamps the combined set.
      assert length(SubjectSearch.search("combo257", 3)) == 3
    end
  end

  describe "AdminWire.result_to_admin_json/1" do
    test "maps a :user result to string-tagged JSON with a null network" do
      result = %Result{type: :user, id: "u-123", network: nil, nick: "vjt"}

      assert AdminWire.result_to_admin_json(result) == %{
               type: "user",
               id: "u-123",
               network: nil,
               nick: "vjt"
             }
    end

    test "maps a :visitor result to string-tagged JSON carrying the network slug" do
      result = %Result{type: :visitor, id: "v-456", network: "azzurra", nick: "guest"}

      assert AdminWire.result_to_admin_json(result) == %{
               type: "visitor",
               id: "v-456",
               network: "azzurra",
               nick: "guest"
             }
    end
  end
end
