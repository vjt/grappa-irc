defmodule Grappa.Net.PinnedHttp do
  @moduledoc """
  One HTTP request to an address already vetted by `Grappa.Net.Ssrf`, on a
  connection opened for that request alone (#2401).

  The caller resolves the host through `Grappa.Net.Ssrf.resolve_safe/1` and
  hands over the answer; this module dials THAT address — never the name, so
  there is no second lookup a rebinding name could win — while the original
  host stays the `Host` header, the TLS SNI and the name the certificate is
  checked against (Mint's `:hostname`, `verify_peer` against the OS trust
  store). Redirects are not a concept here: a 3xx comes back as the status
  it is.

  ## Why Mint and one connection per request, not a pool

  A pinned request needs per-request connect options (the hostname), and
  `Req` turns every distinct `connect_options` set into a new
  `Module.concat`-named Finch instance that is never stopped
  (`Req.Finch.finch_name/1`). When the host comes from a client — a push
  endpoint — that is one atom and one supervision tree per hostname the
  client can mint, forever. A connection that lives for one request leaves
  nothing behind, and push volume is far too low for the handshake to
  matter.

  The socket runs in Mint's passive mode, so nothing lands in the caller's
  mailbox — the caller may be a test process asserting on its own messages.

  ## Bounds

    * `:connect_timeout` — TCP + TLS establishment.
    * `:deadline` — wall-clock budget for the whole response after connect.
      A per-read timeout would restart on every chunk, so a server trickling
      bytes could hold the caller indefinitely; this one does not restart.
    * `:max_body` — bytes of response body kept; past it the request fails
      with `:too_large` rather than buffering a server's whole error page.
  """
  use Boundary, top_level?: true, deps: []

  @type opts :: [
          connect_timeout: pos_integer(),
          deadline: pos_integer(),
          max_body: non_neg_integer()
        ]

  @type response :: %{
          status: non_neg_integer(),
          headers: [{String.t(), String.t()}],
          body: binary()
        }

  @type error :: :too_large | :timeout | {:transport, term()}

  @doc """
  Sends `method` to `uri`'s path and query on a fresh connection to `ip`,
  with `uri.host` as `Host`, SNI and certificate name. `uri.scheme` must be
  `"http"` or `"https"`. Never raises on a network outcome; the connection is
  closed before returning.
  """
  @spec request(String.t(), URI.t(), :inet.ip_address(), [{String.t(), String.t()}], iodata(), opts()) ::
          {:ok, response()} | {:error, error()}
  def request(method, %URI{scheme: scheme, host: host, port: port} = uri, ip, headers, body, opts)
      when scheme in ["http", "https"] and is_binary(host) and is_integer(port) do
    connect_timeout = Keyword.fetch!(opts, :connect_timeout)
    deadline = System.monotonic_time(:millisecond) + Keyword.fetch!(opts, :deadline)
    max_body = Keyword.fetch!(opts, :max_body)

    with {:ok, conn} <- connect(uri, ip, connect_timeout),
         {:ok, conn, ref} <- send_request(conn, method, uri, headers, body) do
      {result, conn} = read(conn, ref, deadline, max_body, %{status: nil, headers: [], body: [], size: 0})
      _ = Mint.HTTP.close(conn)
      result
    end
  end

  defp connect(%URI{scheme: scheme, host: host, port: port}, ip, connect_timeout) do
    transport_opts = [timeout: connect_timeout] ++ if(tuple_size(ip) == 8, do: [inet6: true], else: [])

    case Mint.HTTP.connect(mint_scheme(scheme), ip, port,
           hostname: host,
           mode: :passive,
           protocols: [:http1],
           transport_opts: transport_opts
         ) do
      {:ok, conn} -> {:ok, conn}
      {:error, reason} -> {:error, {:transport, reason}}
    end
  end

  defp mint_scheme("http"), do: :http
  defp mint_scheme("https"), do: :https

  defp send_request(conn, method, uri, headers, body) do
    case Mint.HTTP.request(conn, method, request_target(uri), [{"host", host_header(uri)} | headers], body) do
      {:ok, conn, ref} ->
        {:ok, conn, ref}

      {:error, conn, reason} ->
        _ = Mint.HTTP.close(conn)
        {:error, {:transport, reason}}
    end
  end

  defp read(conn, ref, deadline, max_body, acc) do
    case deadline - System.monotonic_time(:millisecond) do
      remaining when remaining <= 0 -> {{:error, :timeout}, conn}
      remaining -> conn |> Mint.HTTP.recv(0, remaining) |> received(ref, deadline, max_body, acc)
    end
  end

  defp received({:ok, conn, responses}, ref, deadline, max_body, acc) do
    case collect(responses, ref, max_body, acc) do
      {:done, response} -> {{:ok, response}, conn}
      {:cont, acc} -> read(conn, ref, deadline, max_body, acc)
      {:error, reason} -> {{:error, reason}, conn}
    end
  end

  defp received({:error, conn, %{reason: :timeout}, _}, _, _, _, _), do: {{:error, :timeout}, conn}
  defp received({:error, conn, reason, _}, _, _, _, _), do: {{:error, {:transport, reason}}, conn}

  defp collect([], _, _, acc), do: {:cont, acc}

  defp collect([{:status, ref, status} | rest], ref, max_body, acc),
    do: collect(rest, ref, max_body, %{acc | status: status})

  defp collect([{:headers, ref, headers} | rest], ref, max_body, acc),
    do: collect(rest, ref, max_body, %{acc | headers: acc.headers ++ headers})

  defp collect([{:data, ref, data} | rest], ref, max_body, acc) do
    size = acc.size + byte_size(data)

    if size > max_body,
      do: {:error, :too_large},
      else: collect(rest, ref, max_body, %{acc | body: [acc.body, data], size: size})
  end

  defp collect([{:done, ref} | _], ref, _, acc),
    do: {:done, %{status: acc.status, headers: acc.headers, body: IO.iodata_to_binary(acc.body)}}

  defp collect([{:error, ref, reason} | _], ref, _, _), do: {:error, {:transport, reason}}

  defp collect([_ | rest], ref, max_body, acc), do: collect(rest, ref, max_body, acc)

  defp request_target(%URI{path: path, query: query}) do
    path = if path in [nil, ""], do: "/", else: path
    if query in [nil, ""], do: path, else: path <> "?" <> query
  end

  # The default port stays implicit, as every client writes it; a v6
  # literal is bracketed, as RFC 9110 §7.2 requires of an authority.
  defp host_header(%URI{scheme: scheme, host: host, port: port}) do
    authority = if String.contains?(host, ":"), do: "[" <> host <> "]", else: host
    if port == URI.default_port(scheme), do: authority, else: "#{authority}:#{port}"
  end
end
