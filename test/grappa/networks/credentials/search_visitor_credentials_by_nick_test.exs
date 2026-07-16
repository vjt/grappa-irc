defmodule Grappa.Networks.Credentials.SearchVisitorCredentialsByNickTest do
  @moduledoc """
  #257 — visitor leg of the admin subject-search autocomplete.

  `Credentials.search_visitor_credentials_by_nick/2` is the visitor-scoped
  (`WHERE visitor_id IS NOT NULL`) substring search over the per-network
  visitor `nick`, rfc1459-folded (GH #121) so a case/bracket variant
  resolves the same way login does, and LIKE-escaped so an underscore in a
  nick matches literally. It returns `%Credential{}` rows with `:network`
  preloaded (the caller renders the network slug), ordered by nick.

  A multi-network visitor holding the same nick on N networks yields N
  rows — the "network - nickname" disambiguation the operator needs. A
  USER credential with a matching nick is NEVER returned (subject
  isolation; the phase-1 subject-blind-reader class).

  ## Test isolation

  `async: true` — every test scopes to freshly-created rows through the
  Repo sandbox.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials}

  describe "search_visitor_credentials_by_nick/2" do
    test "matches a visitor credential by case-insensitive substring, network preloaded" do
      {visitor, network} = visitor_with_network(7001)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "Mezmerize",
          auth_method: :none
        })

      assert [%Credential{} = cred] =
               Credentials.search_visitor_credentials_by_nick("mezmer", 10)

      assert cred.visitor_id == visitor.id
      assert is_nil(cred.user_id)
      assert cred.nick == "Mezmerize"
      # `:network` is preloaded so the caller can render the slug without a
      # Repo dep at the web boundary.
      assert cred.network.slug == network.slug
    end

    test "folds rfc1459 bracket variants (GH #121)" do
      {visitor, network} = visitor_with_network(7002)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "foo{bar",
          auth_method: :none
        })

      # `[` folds to `{`, so a bracket-variant query resolves the SAME
      # credential the folded index stores.
      assert [%Credential{nick: "foo{bar"}] =
               Credentials.search_visitor_credentials_by_nick("foo[bar", 10)
    end

    test "returns one row per network for a multi-network visitor holding the same nick" do
      {visitor, net_a} = visitor_with_network(7003)
      net_b = network_fixture()

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_a.id, %{
          nick: "dualnick",
          sasl_user: "dualnick",
          auth_method: :none
        })

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: "dualnick",
          sasl_user: "dualnick",
          auth_method: :none
        })

      results = Credentials.search_visitor_credentials_by_nick("dualnick", 10)

      assert length(results) == 2
      assert Enum.all?(results, &(&1.visitor_id == visitor.id))
      slugs = results |> Enum.map(& &1.network.slug) |> Enum.sort()
      assert slugs == Enum.sort([net_a.slug, net_b.slug])
    end

    test "does NOT return a USER credential with a matching nick (subject isolation)" do
      user = user_fixture()
      network = network_fixture()
      _ = credential_fixture(user, network, %{nick: "shared"})

      assert Credentials.search_visitor_credentials_by_nick("shared", 10) == []
    end

    test "an underscore in the query matches literally (LIKE metachar escaped)" do
      {visitor, net_a} = visitor_with_network(7004)
      net_b = network_fixture()

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_a.id, %{
          nick: "foo_x",
          sasl_user: "foo_x",
          auth_method: :none
        })

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: "fooax",
          sasl_user: "fooax",
          auth_method: :none
        })

      assert [%Credential{nick: "foo_x"}] =
               Credentials.search_visitor_credentials_by_nick("foo_x", 10)
    end

    test "a blank query returns [] without scanning" do
      {visitor, network} = visitor_with_network(7005)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, network.id, %{
          nick: "present",
          auth_method: :none
        })

      assert Credentials.search_visitor_credentials_by_nick("", 10) == []
      assert Credentials.search_visitor_credentials_by_nick("   ", 10) == []
    end

    test "honours the limit" do
      {visitor, net_a} = visitor_with_network(7006)
      net_b = network_fixture()
      net_c = network_fixture()

      for {net, i} <- Enum.with_index([net_a, net_b, net_c]) do
        {:ok, _} =
          Credentials.upsert_visitor_credential(visitor.id, net.id, %{
            nick: "limitnick#{i}",
            sasl_user: "limitnick#{i}",
            auth_method: :none
          })
      end

      assert length(Credentials.search_visitor_credentials_by_nick("limitnick", 2)) == 2
    end
  end
end
