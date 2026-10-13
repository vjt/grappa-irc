defmodule Grappa.Net.PinnedHttpTest do
  @moduledoc """
  #2401 — one request to a vetted address, on a connection of its own.

  Bypass listens on 127.0.0.1; every request names a host that cannot
  resolve (`pinned.invalid`, RFC 6761 §6.4), so a request that arrives at
  all arrived at the address passed in, not at a lookup of the name.
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.PinnedHttp

  @loopback {127, 0, 0, 1}
  @opts [connect_timeout: 1_000, deadline: 1_000, max_body: 1_024]

  setup do
    {:ok, bypass: Bypass.open()}
  end

  defp uri(bypass, path), do: URI.parse("http://pinned.invalid:#{bypass.port}#{path}")

  test "dials the given address, sends the original host as Host, returns status, headers and body",
       %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/wp/abc", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)

      conn
      |> Plug.Conn.put_resp_header("x-seen-host", Enum.join(Plug.Conn.get_req_header(conn, "host")))
      |> Plug.Conn.put_resp_header("x-seen-query", conn.query_string)
      |> Plug.Conn.resp(201, "got:" <> body)
    end)

    assert {:ok, %{status: 201, headers: headers, body: "got:payload"}} =
             PinnedHttp.request("POST", uri(bypass, "/wp/abc?x=1"), @loopback, [], "payload", @opts)

    assert {"x-seen-host", "pinned.invalid:#{bypass.port}"} in headers
    assert {"x-seen-query", "x=1"} in headers
  end

  test "a redirect is returned as the status it is, never followed", %{bypass: bypass} do
    # Bypass fails the test on a request to any path it was not told to expect.
    Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("location", "http://127.0.0.1:#{bypass.port}/elsewhere")
      |> Plug.Conn.resp(302, "")
    end)

    assert {:ok, %{status: 302}} = PinnedHttp.request("POST", uri(bypass, "/wp"), @loopback, [], "", @opts)
  end

  test "a body past max_body fails as :too_large instead of being buffered", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
      Plug.Conn.resp(conn, 500, String.duplicate("x", 4_096))
    end)

    assert {:error, :too_large} = PinnedHttp.request("POST", uri(bypass, "/wp"), @loopback, [], "", @opts)
  end

  test "a server that accepts and never answers fails as :timeout at the deadline" do
    # A raw listener, not Bypass: closing on a handler that is still running
    # is exactly what this test does, and Bypass reports that as a failure.
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, ip: @loopback])
    {:ok, port} = :inet.port(listen)
    test_pid = self()

    acceptor =
      spawn_link(fn ->
        {:ok, socket} = :gen_tcp.accept(listen)
        send(test_pid, :accepted)
        receive do: (:stop -> :gen_tcp.close(socket))
      end)

    on_exit(fn -> send(acceptor, :stop) end)

    started = System.monotonic_time(:millisecond)

    assert {:error, :timeout} =
             PinnedHttp.request(
               "POST",
               URI.parse("http://pinned.invalid:#{port}/wp"),
               @loopback,
               [],
               "",
               Keyword.put(@opts, :deadline, 200)
             )

    assert_received :accepted
    assert System.monotonic_time(:millisecond) - started < 1_000
  end

  test "a refused connection is a transport error", %{bypass: bypass} do
    Bypass.down(bypass)

    assert {:error, {:transport, _}} = PinnedHttp.request("POST", uri(bypass, "/wp"), @loopback, [], "", @opts)
  end

  test "nothing lands in the caller's mailbox", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

    assert {:ok, %{status: 201}} = PinnedHttp.request("POST", uri(bypass, "/wp"), @loopback, [], "", @opts)
    refute_received _
  end
end
