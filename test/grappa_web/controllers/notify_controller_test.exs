defmodule GrappaWeb.NotifyControllerTest do
  @moduledoc """
  `/networks/:network_id/notify` — REST surface for the #247 presence
  watch list.

  Coverage:
    * GET: empty list + `presence: null` honesty signal when no
      session is running (DB state and live state are separate
      sources of truth).
    * POST: atomic batch add (201), idempotent duplicate, 422 on an
      invalid nick in the batch, 400 on malformed payloads.
    * DELETE /:nick: fold-matched idempotent remove.
    * DELETE (bare): clear.
    * 404 via ResolveNetwork on a network the subject has no
      credential for.

  `async: true` — no PubSub-global assertions here (the broadcast
  contract is covered in `Grappa.NotifyTest`); each test uses its own
  user + network.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  defp uniq, do: System.unique_integer([:positive])

  setup %{conn: conn} do
    {user, session} = user_and_session()
    {network, _} = network_with_server(port: 7601, slug: "notify-net-#{uniq()}")
    _ = credential_fixture(user, network)

    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  test "GET returns empty entries and null presence when nothing is set up", %{
    conn: conn,
    network: network
  } do
    resp =
      conn
      |> get("/networks/#{network.slug}/notify")
      |> json_response(200)

    assert resp == %{"entries" => [], "presence" => nil}
  end

  test "POST adds a batch and GET lists it back", %{conn: conn, network: network} do
    resp =
      conn
      |> post("/networks/#{network.slug}/notify", %{"nicks" => ["Foo", "Bar"]})
      |> json_response(201)

    assert [%{"nick" => "Foo"}, %{"nick" => "Bar"}] = resp["entries"]

    listed =
      conn
      |> get("/networks/#{network.slug}/notify")
      |> json_response(200)

    assert [%{"nick" => "Foo"}, %{"nick" => "Bar"}] = listed["entries"]
    assert Enum.all?(listed["entries"], &(&1["network_id"] == network.id))
  end

  test "POST duplicate (fold-equal) add is idempotent", %{conn: conn, network: network} do
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["Foo[1]"]})
    |> json_response(201)

    resp =
      conn
      |> post("/networks/#{network.slug}/notify", %{"nicks" => ["foo{1}"]})
      |> json_response(201)

    # First-add display form wins; still one row.
    assert [%{"nick" => "Foo[1]"}] = resp["entries"]

    listed = conn |> get("/networks/#{network.slug}/notify") |> json_response(200)
    assert length(listed["entries"]) == 1
  end

  test "POST rejects the whole batch when one nick is invalid", %{conn: conn, network: network} do
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["ok_nick", "#chan"]})
    |> json_response(422)

    listed = conn |> get("/networks/#{network.slug}/notify") |> json_response(200)
    assert listed["entries"] == []
  end

  test "POST malformed payloads are 400", %{conn: conn, network: network} do
    assert conn
           |> post("/networks/#{network.slug}/notify", %{"nicks" => []})
           |> json_response(400)

    assert conn
           |> post("/networks/#{network.slug}/notify", %{"nicks" => [42]})
           |> json_response(400)

    assert conn
           |> post("/networks/#{network.slug}/notify", %{})
           |> json_response(400)
  end

  test "DELETE /:nick removes fold-matched and is idempotent", %{conn: conn, network: network} do
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["Foo[1]", "Bar"]})
    |> json_response(201)

    assert conn
           |> delete("/networks/#{network.slug}/notify/FOO{1}")
           |> json_response(200) == %{"ok" => true}

    listed = conn |> get("/networks/#{network.slug}/notify") |> json_response(200)
    assert [%{"nick" => "Bar"}] = listed["entries"]

    # Idempotent re-delete.
    assert conn
           |> delete("/networks/#{network.slug}/notify/foo[1]")
           |> json_response(200) == %{"ok" => true}
  end

  test "DELETE clears the whole network list", %{conn: conn, network: network} do
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["Foo", "Bar"]})
    |> json_response(201)

    assert conn
           |> delete("/networks/#{network.slug}/notify")
           |> json_response(200) == %{"ok" => true}

    listed = conn |> get("/networks/#{network.slug}/notify") |> json_response(200)
    assert listed["entries"] == []
  end

  test "404 on a network the subject holds no credential for", %{conn: conn} do
    {other_network, _} = network_with_server(port: 7602, slug: "notify-other-#{uniq()}")

    assert conn
           |> get("/networks/#{other_network.slug}/notify")
           |> json_response(404)
  end
end
