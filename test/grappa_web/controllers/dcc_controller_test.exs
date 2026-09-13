defmodule GrappaWeb.DccControllerTest do
  @moduledoc """
  issue 2089 — the four REST doors behind the DCC consent banner.

  Two nouns, two controllers, and the split is the point: an OFFER is
  per-session memory with a hold that runs out, a FILE is bytes on disk
  with a retention the reaper enforces. They have different lifetimes and
  the same gate, so they are separate resources rather than one with a
  mode.

  What this file has to pin beyond the happy paths:

    * the accept answers **202**, not 200. The transfer runs detached and
      the outcome arrives as a scrollback row, so a 200 would be claiming
      an arrival nobody has observed;
    * a handle that names nothing is **404** on both write doors — they
      are HTTP-reachable and must not double as a way to silently succeed;
    * the file door serves `application/octet-stream` with
      `Content-Disposition: attachment` and `nosniff`. These bytes came
      off a stranger's socket: anything that lets a browser decide for
      itself what they are is a stored-XSS door;
    * a slug belonging to ANOTHER subject is 404 and not 403 — the
      ownership answer must not double as an existence oracle.

  `async: false` for the usual singleton reason (`Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub`).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Dcc, IRCServer, Session}

  @nick "grappa-test"
  @public_ip "1.2.3.4"
  @filename "holiday.jpg"
  @size 12_345
  @bytes "the stranger's bytes"

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{u()}")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
  end

  describe "GET /networks/:network_id/dcc_offers" do
    test "lists the held offer in the same shape the live event carried", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")

      assert %{"offers" => [offer]} = json_response(conn, 200)
      assert offer["offer_id"] == offer_id
      assert offer["from"] == "alice"
      assert offer["filename"] == @filename
      assert offer["size"] == @size
      assert offer["channel"] == "$server"
    end

    test "holding nothing lists nothing", ctx do
      %{network: network} = connected(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")

      assert json_response(conn, 200) == %{"offers" => []}
    end
  end

  describe "POST /networks/:network_id/dcc_offers/:offer_id/accept" do
    test "answers 202 — admitted and started, never arrived", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = post(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}/accept")

      assert json_response(conn, 202) == %{"ok" => true}
    end

    test "a handle that names nothing is 404", ctx do
      %{network: network} = held_offer(ctx.vjt)

      conn = post(ctx.conn, "/networks/#{network.slug}/dcc_offers/nosuchhandle/accept")

      assert json_response(conn, 404) == %{"error" => "not_held"}
    end
  end

  describe "DELETE /networks/:network_id/dcc_offers/:offer_id" do
    test "refuses the offer and answers 200 — the drop is fully applied", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)

      conn = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      assert json_response(conn, 200) == %{"ok" => true}

      listed = get(ctx.conn, "/networks/#{network.slug}/dcc_offers")
      assert json_response(listed, 200) == %{"offers" => []}
    end

    test "refusing twice is 404 the second time, not a silent success", ctx do
      %{network: network, offer_id: offer_id} = held_offer(ctx.vjt)
      _ = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      conn = delete(ctx.conn, "/networks/#{network.slug}/dcc_offers/#{offer_id}")

      assert json_response(conn, 404) == %{"error" => "not_held"}
    end
  end

  describe "GET /networks/:network_id/dcc_files/:slug" do
    test "serves the bytes as an opaque attachment the browser may not interpret", ctx do
      %{network: network, slug: slug} = spooled(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_files/#{slug}")

      assert response(conn, 200) == @bytes
      assert get_resp_header(conn, "content-type") == ["application/octet-stream"]
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
      assert [disposition] = get_resp_header(conn, "content-disposition")
      assert disposition =~ "attachment"
    end

    test "a slug that names nothing is 404", ctx do
      %{network: network} = connected(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_files/#{Dcc.mint_slug()}")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "a malformed slug is 404 and never reaches the filesystem", ctx do
      %{network: network} = connected(ctx.vjt)

      conn = get(ctx.conn, "/networks/#{network.slug}/dcc_files/..%2F..%2Fetc%2Fpasswd")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "another subject's spooled file is 404, not 403 — no existence oracle", ctx do
      %{slug: slug} = spooled(ctx.vjt)

      mallory = user_fixture(name: "mallory-#{u()}")
      %{network: other} = connected(mallory)
      mallory_conn = put_bearer(build_conn(), session_fixture(mallory).id)

      conn = get(mallory_conn, "/networks/#{other.slug}/dcc_files/#{slug}")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  # Boots a session and feeds a real DCC SEND, returning the minted handle.
  # Driven through the parser + EventRouter rather than poked into state:
  # the routing and the neutralisation both happen on that ingress path,
  # and a test that bypassed it would pass while the real door missed.
  defp held_offer(user) do
    ctx = connected(user)

    IRCServer.feed(
      ctx.server,
      ":alice!u@h PRIVMSG #{@nick} :\x01DCC SEND #{@filename} #{@public_ip} 5000 #{@size}\x01\r\n"
    )

    IRCServer.feed(ctx.server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(ctx.server, &(&1 == "PONG :flush\r\n"), 1_000)

    {:ok, [%{offer_id: offer_id}]} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    Map.put(ctx, :offer_id, offer_id)
  end

  # A spooled file, written the way the session writes one: bytes on disk
  # first, then the row.
  defp spooled(user) do
    ctx = connected(user)
    slug = Dcc.mint_slug()
    :ok = File.write!(Dcc.storage_path(slug), @bytes)

    {:ok, _} =
      Dcc.store(ctx.subject, ctx.network.id, slug, %{
        peer_nick: "alice",
        filename: @filename,
        bytes: byte_size(@bytes),
        retention_seconds: Dcc.retention_seconds(nil)
      })

    Map.put(ctx, :slug, slug)
  end

  defp connected(user) do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {network, _} = network_with_server(port: port, slug: "azzurra-#{u()}")
    _ = credential_fixture(user, network, %{nick: @nick, autojoin_channels: []})

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

    %{server: server, pid: pid, network: network, subject: {:user, user.id}}
  end

  defp u, do: System.unique_integer([:positive])
end
