defmodule Grappa.Net.ImageFetcher.Req do
  @moduledoc """
  Real fetch-by-URL image fetcher (#75) — `Req` over an SSRF-guarded, rebind-safe
  connection.

  Flow:

    1. Parse the URL; only `http`/`https` with a real host are accepted.
    2. Resolve the host through the injected SSRF resolver
       (`Grappa.Net.Ssrf.resolve_safe/1` in prod). The resolver returns ONE safe
       IP, or blocks the whole host.
    3. Connect to that **resolved IP** (not the hostname) with `Host`/SNI set to
       the original host — so a DNS-rebind between check and connect can't swing
       us onto an internal address.
    4. Do NOT follow redirects (a 3xx would be a second, un-guarded hop → SSRF
       bypass); a non-200 is `:fetch_failed`.
    5. Enforce a raster content-type allowlist and a hard byte cap.

  Never raises — every failure is a tagged `Grappa.Net.ImageFetcher.error`.

  ## Size cap posture

  The cap is the caller's `max_bytes`, enforced WHILE the body streams
  (#2402): a declared `content-length` over the cap is refused on the first
  chunk, before the rest of the body is read, and every received chunk is
  counted against the cap whatever the header claimed — a chunked or
  length-less response is stopped the moment it passes, and the connection
  is dropped rather than drained. At most `max_bytes` plus one chunk is ever
  held in memory. `@receive_timeout_ms` bounds the other axis, a server that
  sends slowly rather than much.
  """
  @behaviour Grappa.Net.ImageFetcher

  alias Grappa.Net.ImageFetcher

  require Logger

  @connect_timeout_ms 5_000
  @receive_timeout_ms 10_000

  # Injected SSRF resolver (module exposing `resolve_safe/1`). Prod/dev default
  # is the real guard; `config/test.exs` swaps in a loopback-permitting resolver
  # so Bypass is reachable while private ranges stay blocked. Mirrors the
  # `:vhost_ptr_resolver` seam.
  @resolver Application.compile_env(:grappa, [:themes, :image_ssrf_resolver], Grappa.Net.Ssrf)

  @impl ImageFetcher
  def fetch(url, max_bytes) when is_binary(url) and is_integer(max_bytes) and max_bytes > 0 do
    with {:ok, uri} <- parse_http_uri(url),
         {:ok, ip} <- @resolver.resolve_safe(uri.host) do
      get(uri, ip, max_bytes)
    else
      {:error, :ssrf_blocked} = err -> err
      # DNS failure / bad URL / non-http scheme all collapse to fetch_failed —
      # the caller can't act differently and the distinction leaks resolver
      # internals.
      {:error, _} -> {:error, :fetch_failed}
    end
  end

  defp get(uri, ip, max_bytes) do
    target = URI.to_string(%{uri | host: ip_host(ip)})

    opts = [
      redirect: false,
      decode_body: false,
      retry: false,
      cache: false,
      max_retries: 0,
      receive_timeout: @receive_timeout_ms,
      into: capped_body(max_bytes),
      connect_options: connect_options(uri),
      headers: [{"host", uri.host}]
    ]

    case request(target, opts) do
      {:ok, %Req.Response{status: 200} = resp} -> classify(resp, max_bytes)
      {:ok, %Req.Response{}} -> {:error, :fetch_failed}
      {:error, _} -> {:error, :fetch_failed}
    end
  end

  # Req.get/2 returns {:ok, resp} | {:error, exception} and does not raise on
  # transport errors, but a malformed target could; the no-raise contract is
  # belt-and-braces here.
  defp request(target, opts) do
    Req.get(target, opts)
  rescue
    _ -> {:error, :fetch_failed}
  catch
    _, _ -> {:error, :fetch_failed}
  end

  defp classify(%Req.Response{body: body} = resp, max_bytes) do
    content_type = response_content_type(resp)

    cond do
      Req.Response.get_private(resp, :over_cap) ->
        log_over_cap(resp, max_bytes)
        {:error, :too_large}

      content_type not in ImageFetcher.raster_content_types() ->
        {:error, :not_raster}

      true ->
        {:ok, body, content_type}
    end
  end

  # Req calls this per received chunk, with the status + headers already on
  # `resp`. A non-200 is halted on its first chunk — `get/3` refuses it
  # anyway, so its body is never worth reading.
  defp capped_body(max_bytes) do
    fn {:data, data}, {req, resp} ->
      received = byte_size(resp.body) + byte_size(data)

      cond do
        resp.status != 200 ->
          {:halt, {req, resp}}

        declared_length(resp) > max_bytes or received > max_bytes ->
          {:halt, {req, Req.Response.put_private(resp, :over_cap, received)}}

        true ->
          {:cont, {req, %{resp | body: resp.body <> data}}}
      end
    end
  end

  # An absent or unparseable header is 0: it bounds nothing, and the bytes
  # are counted regardless.
  defp declared_length(resp) do
    with [value | _] <- Req.Response.get_header(resp, "content-length"),
         {n, ""} <- Integer.parse(value) do
      n
    else
      _ -> 0
    end
  end

  defp log_over_cap(resp, max_bytes) do
    Logger.info(
      "image_fetcher: refused body past cap received_bytes=#{Req.Response.get_private(resp, :over_cap)} " <>
        "declared_length=#{resp |> Req.Response.get_header("content-length") |> List.first("none")} cap=#{max_bytes}"
    )
  end

  # Strip `; charset=…` parameters and downcase so `image/JPEG; charset=binary`
  # matches the allowlist. A missing header yields "" (→ :not_raster).
  defp response_content_type(resp) do
    resp
    |> Req.Response.get_header("content-type")
    |> List.first("")
    |> String.split(";", parts: 2)
    |> List.first()
    |> String.trim()
    |> String.downcase()
  end

  defp parse_http_uri(url) do
    case URI.parse(url) do
      %URI{scheme: scheme, host: host, port: port}
      when scheme in ["http", "https"] and is_binary(host) and host != "" and is_integer(port) ->
        {:ok, URI.parse(url)}

      _ ->
        {:error, :fetch_failed}
    end
  end

  # v6 addresses must be bracketed in a URL authority.
  defp ip_host(ip) when tuple_size(ip) == 8, do: "[" <> ip_string(ip) <> "]"
  defp ip_host(ip), do: ip_string(ip)

  defp ip_string(ip), do: ip |> :inet.ntoa() |> List.to_string()

  # SNI + cert hostname check must target the ORIGINAL host, not the IP we dial.
  defp connect_options(%URI{scheme: "https", host: host}),
    do: [timeout: @connect_timeout_ms, hostname: host]

  defp connect_options(_), do: [timeout: @connect_timeout_ms]
end
