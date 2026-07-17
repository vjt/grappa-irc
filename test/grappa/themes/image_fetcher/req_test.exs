defmodule Grappa.Themes.ImageFetcher.ReqTest do
  @moduledoc """
  The real URL image fetcher (#75). The SSRF resolver is injected in
  `config/test.exs` (`Grappa.ThemesSsrfTestResolver`) so a Bypass server on
  loopback is reachable for the HTTP-classification cases, while private ranges
  still route through the real `Grappa.Net.Ssrf` guard.
  """
  use ExUnit.Case, async: true

  alias Grappa.Themes.ImageFetcher.Req, as: Fetcher

  # Minimal PNG signature + padding — enough to assert byte round-trip.
  @png <<137, 80, 78, 71, 13, 10, 26, 10>> <> :binary.copy(<<0>>, 64)

  setup do
    {:ok, bypass: Bypass.open()}
  end

  test "fetches a raster image and returns its bytes + content-type", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/bg.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.resp(200, @png)
    end)

    assert {:ok, @png, "image/png"} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/bg.png")
  end

  test "normalises a content-type with parameters", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/bg.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/jpeg; charset=binary")
      |> Plug.Conn.resp(200, @png)
    end)

    assert {:ok, @png, "image/jpeg"} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/bg.png")
  end

  test "rejects a non-raster content-type", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/x", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "text/html")
      |> Plug.Conn.resp(200, "<html></html>")
    end)

    assert {:error, :not_raster} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/x")
  end

  test "rejects an SVG content-type (scriptable, not raster)", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/x.svg", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/svg+xml")
      |> Plug.Conn.resp(200, "<svg/>")
    end)

    assert {:error, :not_raster} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/x.svg")
  end

  test "rejects an oversized body", %{bypass: bypass} do
    big = :binary.copy(<<0>>, 9 * 1024 * 1024)

    Bypass.expect_once(bypass, "GET", "/big.png", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("content-type", "image/png")
      |> Plug.Conn.resp(200, big)
    end)

    assert {:error, :too_large} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/big.png")
  end

  test "maps a non-200 response to fetch_failed", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/nope", fn conn -> Plug.Conn.resp(conn, 404, "") end)

    assert {:error, :fetch_failed} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/nope")
  end

  test "does not follow redirects (a 3xx is fetch_failed)", %{bypass: bypass} do
    Bypass.expect_once(bypass, "GET", "/redir", fn conn ->
      conn
      |> Plug.Conn.put_resp_header("location", "http://127.0.0.1:1/evil")
      |> Plug.Conn.resp(302, "")
    end)

    assert {:error, :fetch_failed} = Fetcher.fetch("http://127.0.0.1:#{bypass.port}/redir")
  end

  test "blocks a host that resolves to a private address" do
    # The test resolver delegates non-loopback hosts to the real SSRF guard,
    # which refuses RFC-1918 space — no socket is opened.
    assert {:error, :ssrf_blocked} = Fetcher.fetch("http://10.0.0.1/x.png")
  end

  test "rejects a non-http(s) scheme" do
    assert {:error, :fetch_failed} = Fetcher.fetch("ftp://example.com/x.png")
  end

  test "rejects a malformed URL" do
    assert {:error, :fetch_failed} = Fetcher.fetch("not a url")
  end
end
