defmodule GrappaWeb.IgnoresControllerTest do
  @moduledoc """
  `/networks/:network_id/ignores` (#162, issue 2294). The list is the reply on
  every verb, the iso boundary is the shared `:resolve_network` 404, and the
  refusal tokens the fallback renders are pinned by shape.

  The payload assertions are WHOLE-map equalities on purpose: `masks` is the
  #162 field and the additive contract says it must keep carrying exactly the
  mask strings, in the same order, beside the richer `entries`. A partial
  assertion could not notice `masks` quietly becoming a list of objects,
  which is the one change the wire forbids.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.UserSettings

  setup %{conn: conn} do
    {user, session} = user_and_session()
    network = network_fixture(slug: "azzurra")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  describe "GET /networks/:network_id/ignores" do
    test "401 without bearer", %{network: network} do
      conn = get(build_conn(), "/networks/#{network.slug}/ignores")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "empty list when nothing is ignored", %{conn: conn, network: network} do
      assert json_response(get(conn, "/networks/#{network.slug}/ignores"), 200) ==
               %{"masks" => [], "entries" => []}
    end

    test "reflects the stored list", %{conn: conn, user: user, network: network} do
      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "spambot", nil, :ascii)

      assert json_response(get(conn, "/networks/#{network.slug}/ignores"), 200) ==
               %{
                 "masks" => ["spambot!*@*"],
                 "entries" => [%{"mask" => "spambot!*@*", "text_pattern" => nil}]
               }
    end

    # issue 2294 — the additive seam, stated as an assertion: `masks` still
    # carries the mask string of a TARGETED entry, so a client predating the
    # text pattern keeps seeing every rule it always saw.
    test "a targeted entry still appears in the #162 masks field", %{
      conn: conn,
      user: user,
      network: network
    } do
      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "relay", "<SomeNick>*", :ascii)

      assert json_response(get(conn, "/networks/#{network.slug}/ignores"), 200) ==
               %{
                 "masks" => ["relay!*@*"],
                 "entries" => [%{"mask" => "relay!*@*", "text_pattern" => "<SomeNick>*"}]
               }
    end
  end

  describe "POST /networks/:network_id/ignores" do
    test "201 with the resulting list; a bare nick normalises", %{conn: conn, network: network} do
      conn = post(conn, "/networks/#{network.slug}/ignores", %{"mask" => "SpamBot"})

      assert json_response(conn, 201) ==
               %{
                 "masks" => ["spambot!*@*"],
                 "entries" => [%{"mask" => "spambot!*@*", "text_pattern" => nil}],
                 "mask" => "spambot!*@*",
                 "text_pattern" => nil,
                 "outcome" => "added"
               }
    end

    test "201 carrying the text pattern", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "Gazzurbo!*@*",
          "text_pattern" => "<SomeNick>*"
        })

      assert json_response(conn, 201) ==
               %{
                 "masks" => ["gazzurbo!*@*"],
                 "entries" => [%{"mask" => "gazzurbo!*@*", "text_pattern" => "<SomeNick>*"}],
                 "mask" => "gazzurbo!*@*",
                 "text_pattern" => "<SomeNick>*",
                 "outcome" => "added"
               }
    end

    test "an explicit null text_pattern is the #162 entry", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "spambot",
          "text_pattern" => nil
        })

      assert %{"text_pattern" => nil, "outcome" => "added"} = json_response(conn, 201)
    end

    test "two patterns on one mask are two entries", %{conn: conn, network: network} do
      _ =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "relay",
          "text_pattern" => "<A>*"
        })

      conn =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "relay",
          "text_pattern" => "<B>*"
        })

      assert %{"masks" => ["relay!*@*", "relay!*@*"], "entries" => entries} =
               json_response(conn, 201)

      assert entries == [
               %{"mask" => "relay!*@*", "text_pattern" => "<B>*"},
               %{"mask" => "relay!*@*", "text_pattern" => "<A>*"}
             ]
    end

    test "an idempotent re-add answers the same list", %{conn: conn, network: network} do
      _ = post(conn, "/networks/#{network.slug}/ignores", %{"mask" => "spambot"})
      conn = post(conn, "/networks/#{network.slug}/ignores", %{"mask" => "spambot!*@*"})

      assert json_response(conn, 201) ==
               %{
                 "masks" => ["spambot!*@*"],
                 "entries" => [%{"mask" => "spambot!*@*", "text_pattern" => nil}],
                 "mask" => "spambot!*@*",
                 "text_pattern" => nil,
                 "outcome" => "already_ignored"
               }
    end

    test "422 invalid_mask on an unparseable mask", %{conn: conn, network: network} do
      conn = post(conn, "/networks/#{network.slug}/ignores", %{"mask" => "nick@host!user"})
      assert json_response(conn, 422) == %{"error" => "invalid_mask"}
    end

    test "422 invalid_text_pattern names the half that is wrong", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "relay",
          "text_pattern" => "   "
        })

      assert json_response(conn, 422) == %{"error" => "invalid_text_pattern"}
    end

    test "400 on a text_pattern that is not a string", %{conn: conn, network: network} do
      conn =
        post(conn, "/networks/#{network.slug}/ignores", %{
          "mask" => "relay",
          "text_pattern" => 42
        })

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on a missing or empty mask", %{conn: conn, network: network} do
      assert json_response(post(conn, "/networks/#{network.slug}/ignores", %{}), 400) ==
               %{"error" => "bad_request"}

      assert json_response(post(conn, "/networks/#{network.slug}/ignores", %{"mask" => ""}), 400) ==
               %{"error" => "bad_request"}
    end
  end

  describe "DELETE /networks/:network_id/ignores/:mask" do
    test "removes by normalised mask and answers the resulting list",
         %{conn: conn, user: user, network: network} do
      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "spambot", nil, :ascii)

      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "*!*@evil.example", nil, :ascii)

      conn = delete(conn, "/networks/#{network.slug}/ignores/SPAMBOT")

      assert json_response(conn, 200) ==
               %{
                 "masks" => ["*!*@evil.example"],
                 "entries" => [%{"mask" => "*!*@evil.example", "text_pattern" => nil}],
                 "mask" => "spambot!*@*",
                 "text_pattern" => nil,
                 "outcome" => "removed"
               }
    end

    # The query parameter is the only place the pattern can ride on DELETE —
    # the mask already owns the path segment, and a pattern carries spaces.
    test "the text pattern rides the query string and removes that pair only",
         %{conn: conn, user: user, network: network} do
      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "relay", "<A>*", :ascii)

      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "relay", "<B>*", :ascii)

      conn =
        delete(conn, "/networks/#{network.slug}/ignores/relay!*@*?text_pattern=#{URI.encode_www_form("<A>*")}")

      assert %{
               "mask" => "relay!*@*",
               "text_pattern" => "<A>*",
               "outcome" => "removed",
               "entries" => [%{"text_pattern" => "<B>*"}]
             } = json_response(conn, 200)
    end

    test "a removal naming no pattern does NOT eat a targeted entry",
         %{conn: conn, user: user, network: network} do
      {:ok, _, _, _} =
        UserSettings.add_ignore({:user, user.id}, network.slug, "relay", "<A>*", :ascii)

      conn = delete(conn, "/networks/#{network.slug}/ignores/relay!*@*")

      assert %{"outcome" => "not_ignored", "entries" => [%{"text_pattern" => "<A>*"}]} =
               json_response(conn, 200)
    end

    test "is idempotent — an absent mask still answers the list", %{conn: conn, network: network} do
      conn = delete(conn, "/networks/#{network.slug}/ignores/nobody")

      assert json_response(conn, 200) ==
               %{
                 "masks" => [],
                 "entries" => [],
                 "mask" => "nobody!*@*",
                 "text_pattern" => nil,
                 "outcome" => "not_ignored"
               }
    end
  end
end
