defmodule Grappa.Net.ImageFetcher.ReqTest do
  @moduledoc """
  The real URL image fetcher (#75). The SSRF resolver is injected in
  `config/test.exs` (`Grappa.ThemesSsrfTestResolver`) so a Bypass server on
  loopback is reachable for the HTTP-classification cases, while private ranges
  still route through the real `Grappa.Net.Ssrf` guard.
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.ImageFetcher.Req, as: Fetcher

  # Minimal PNG signature + padding — enough to assert byte round-trip.
  @png <<137, 80, 78, 71, 13, 10, 26, 10>> <> :binary.copy(<<0>>, 64)

  # The caller's byte ceiling. Small on purpose: the streaming cases below
  # must show the client hanging up long before a hostile server is done.
  @cap 64 * 1024
  @chunk :binary.copy(<<0>>, 16 * 1024)
  # What the hostile server is willing to send — 1024x the cap.
  @hostile_total 64 * 1024 * 1024

  setup do
    {:ok, bypass: Bypass.open()}
  end

  test "fetches a raster image and returns its bytes + content-type", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/bg.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.resp(200, @png)
    end)

    assert {:ok, @png, "image/png"} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/bg.png", @cap)
  end

  test "normalises a content-type with parameters", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/bg.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/jpeg; charset=binary")
      |> Plug.Conn.resp(200, @png)
    end)

    assert {:ok, @png, "image/jpeg"} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/bg.png", @cap)
  end

  test "rejects a non-raster content-type", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/x", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "text/html")
      |> Plug.Conn.resp(200, "<html></html>")
    end)

    assert {:error, :not_raster} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/x", @cap)
  end

  test "rejects an SVG content-type (scriptable, not raster)", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/x.svg", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/svg+xml")
      |> Plug.Conn.resp(200, "<svg/>")
    end)

    assert {:error, :not_raster} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/x.svg", @cap)
  end

  test "accepts a body exactly at the cap", %{bypass: bypass} do
    body = @png <> :binary.copy(<<0>>, @cap - byte_size(@png))

    Bypass.expect_once(bypass, "GET", "/edge.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.resp(200, body)
    end)

    assert {:ok, ^body, "image/png"} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/edge.png", @cap)
  end

  test "rejects a body one byte over the cap", %{bypass: bypass} do
    body = :binary.copy(<<0>>, @cap + 1)

    Bypass.expect_once(bypass, "GET", "/big.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.resp(200, body)
    end)

    assert {:error, :too_large} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/big.png", @cap)
  end

  # The server streams without a content-length, so only counting the bytes
  # as they arrive can stop it. The handler reports every byte it has handed
  # to the socket; it dies mid-loop once the client hangs up.
  test "hangs up on a chunked body as soon as it passes the cap", %{bypass: bypass} do
    test_pid = self()

    Bypass.stub(bypass, "GET", "/endless.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.send_chunked(200)
      |> stream_hostile(test_pid)
    end)

    assert {:error, :too_large} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/endless.png", @cap)
    assert_stopped_early()
    # The handler is killed mid-stream by the hang-up — the outcome under
    # test, not a server failure for Bypass to report.
    Bypass.pass(bypass)
  end

  # A declared length over the cap is refused on the header, on the FIRST
  # chunk. The server sends one chunk well under the cap and then stalls, so
  # counting alone could not end the request — only the header check does,
  # long before the receive timeout.
  test "refuses a declared content-length over the cap on the first chunk", %{bypass: bypass} do
    Bypass.stub(bypass, "GET", "/declared.png", fn conn ->
      conn =
        conn
        |> Plug.Conn.put_resp_header("content-type", "image/png")
        |> Plug.Conn.put_resp_header("content-length", Integer.to_string(@hostile_total))
        |> Plug.Conn.send_chunked(200)

      {:ok, conn} = Plug.Conn.chunk(conn, @chunk)
      Process.sleep(:infinity)
      conn
    end)

    assert {:error, :too_large} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/declared.png", @cap)
    Bypass.pass(bypass)
  end

  test "maps a non-200 response to fetch_failed", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/nope", fn conn -> Plug.Conn.resp(conn, 404, "") end)

    assert {:error, :fetch_failed} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/nope", @cap)
  end

  test "does not follow redirects (a 3xx is fetch_failed)", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/redir", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("location", "http://127.0.0.1:1/evil")
      |> Plug.Conn.resp(302, "")
    end)

    assert {:error, :fetch_failed} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/redir", @cap)
  end

  test "blocks a host that resolves to a private address" do
    # The test resolver delegates non-loopback hosts to the real SSRF guard,
    # which refuses RFC-1918 space — no socket is opened.
    assert {:error, :ssrf_blocked} = Fetcher.fetch("http://10.0.0.1/x.png", @cap)
  end

  test "rejects a non-http(s) scheme" do
    assert {:error, :fetch_failed} = Fetcher.fetch("ftp://example.com/x.png", @cap)
  end

  test "rejects a malformed URL" do
    assert {:error, :fetch_failed} = Fetcher.fetch("not a url", @cap)
  end

  defp stream_hostile(conn, test_pid), do: stream_hostile(conn, test_pid, 0)

  defp stream_hostile(conn, _, sent) when sent >= @hostile_total, do: conn

  defp stream_hostile(conn, test_pid, sent) do
    case Plug.Conn.chunk(conn, @chunk) do
      {:ok, conn} ->
        sent = sent + byte_size(@chunk)
        send(test_pid, {:hostile_sent, sent})
        stream_hostile(conn, test_pid, sent)

      {:error, _} ->
        conn
    end
  end

  # The last progress report the server managed before the client hung up.
  # Kernel socket buffers let the server run somewhat ahead of the client, so
  # the bound is generous — but a client that read to the end would let all
  # `@hostile_total` bytes through.
  defp assert_stopped_early do
    sent = drain_sent(0)
    assert sent < div(@hostile_total, 8), "server pushed #{sent} bytes before the client hung up"
  end

  defp drain_sent(last) do
    receive do
      {:hostile_sent, n} -> drain_sent(max(n, last))
    after
      200 -> last
    end
  end
end
