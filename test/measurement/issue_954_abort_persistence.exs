defmodule Grappa.Measurement.Issue954AbortPersistence do
  @moduledoc """
  MEASUREMENT HARNESS for GH #954 — NOT a suite test.

  Deliberately named outside the `*_test.exs` pattern so `mix test` never
  collects it. Run it explicitly:

      scripts/test.sh test/measurement/issue_954_abort_persistence.exs

  ## The question

  #954 states its own hole: *"Non ho verificato N volte che il server persista
  sempre il POST abortito … non ho ripetuto la misura variando il momento
  dell'abort (prima/dopo che il server abbia scritto)."*

  So: when the client connection dies mid-POST, does the PRIVMSG reach the
  scrollback, and does that depend on WHEN the death lands?

  This is the load-bearing premise of the remedy vjt chose on 2026-08-08
  (*"the message very probably landed"*). If an aborted POST does NOT land
  near-always, dropping the composer text trades a duplicate for a LOST
  message — the worse of the two failures.

  ## Scope, and the half this CANNOT see

  It answers: **given the request bytes arrived, does the server persist.**
  It does NOT answer: **does a real browser at `pagehide` always flush the
  whole body first.** No TCP harness can; that needs an instrumented browser.
  The `head_only` / `mid_body` rows model the regime where the flush did NOT
  complete, but they say nothing about how often a browser lands there.

  ## Why a raw socket and not Playwright

  `config/test.exs` sets `server: false`, so a `Phoenix.ConnTest` conn has no
  socket to kill — no test in the suite *can* answer this. Here a real Bandit
  listener runs the real endpoint plug and a real TCP connection dies at a
  controlled offset. That is strictly more precise than a browser: Playwright
  cannot place an abort 0ms after the last body byte.

  ## Controls, because a table of "persisted: yes" everywhere proves nothing

  * `head_only` / `mid_body` are NEGATIVE controls — the server never sees a
    complete request, so it must NOT persist. If they persist, the harness is
    measuring something other than what it thinks.
  * every aborted attempt is followed by a `complete` SENTINEL POST asserted
    at 201. That is in-band liveness: it rules out the class of false
    negatives where the row is missing because the #630 budget severed the
    bearer, the #340 bucket was empty, or the session died — not because of
    the abort. Two earlier runs of this harness died exactly that way (a fake
    IRC server that never answered PING let the session hit its 90s liveness
    timeout); the sentinel is what makes such a run fail loudly instead of
    reporting a quiet, false "not persisted".
  * the sentinel doubles as the settle BARRIER. `Session.Server` is one
    serialized mailbox, so a sentinel row that has landed means an earlier
    accepted send was already handled. `@grace_ms` covers the one real race
    (the aborted request still upstream of its own `GenServer.call` when the
    sentinel's call is enqueued).

  ## Two close modes, because they are not the same event

  `FIN` (graceful half-close) and `RST` (`linger: {true, 0}`) reach the server
  differently: a reset can surface as `:econnreset` on a socket the handler
  still holds. A destroyed tab is closer to RST. Both are swept.

  ## Why three tests and not one sweep

  The Sandbox owner is killed at `ownership_timeout` (120s). One combined
  sweep overran it and lost every row, because the table only printed at the
  end. Each test now stays well under the cap AND prints each row as it
  completes, so a run that dies still leaves its evidence.
  """
  # `DataCase`, not `ConnCase`: this harness never builds a `%Plug.Conn{}` —
  # it speaks HTTP over a real socket — and ConnCase's injected
  # `import Phoenix.ConnTest` / `@endpoint` would sit unused under
  # `--warnings-as-errors`. `async: false` puts the Sandbox in shared mode,
  # which is what lets the Bandit handler process see the test's connection.
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Scrollback}
  alias Grappa.RateLimit.TokenBucket

  require Logger

  # Each test is ~9 rows x @n attempts, past ExUnit's 60s default. It must
  # still finish under the Sandbox's 120s `ownership_timeout`, which is the
  # real cap here — the owner dies at 120s and takes the run with it.
  @moduletag timeout: 300_000

  # Repeats per row. 20 is the smallest N where a single deviant observation
  # reads as 5% rather than as noise; a row is cheap (one localhost POST).
  @n 20

  # Tail wait after the sentinel barrier, covering the enqueue race described
  # above. Deliberately generous: a false "not persisted" is the expensive
  # error here, a slow harness is the cheap one.
  @grace_ms 250

  @channel "#bofh"

  # Offsets bracket the measured baseline round-trip (~0.9ms p50 on this host)
  # on both sides. `0` is the sharpest sample: the socket dies in the same
  # breath as the last body byte, before the server can plausibly have
  # finished the handler. If the row still lands there, nothing downstream of
  # request-arrival is cancellable.
  @offsets [0, 1, 2, 5, 10, 25, 50]

  setup do
    {:ok, server} = IRCServer.start_link(pong_handler())
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {network, _} = network_with_server(port: IRCServer.port(server), slug: "azzurra")
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    _ = start_session_for(vjt, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 2_000)

    {:ok, irc: server, vjt: vjt, network: network, token: session.id, port: start_listener()}
  end

  # The upstream link has a 60s idle + 30s liveness deadline; a pure
  # passthrough handler never answers the self-PING, so the session dies
  # mid-sweep and every later row measures a dead session rather than an
  # abort. Answering PING is not decoration — it is what keeps the subject of
  # the measurement alive.
  defp pong_handler do
    fn state, line ->
      case line do
        "PING" <> rest -> {:reply, "PONG" <> rest, state}
        _ -> {:reply, nil, state}
      end
    end
  end

  test "sweep: graceful FIN close at varying offsets", ctx do
    emit(banner(ctx, "FIN (graceful half-close)"))
    sweep(ctx, :fin)
  end

  test "sweep: abrupt RST close at varying offsets", ctx do
    emit(banner(ctx, "RST (linger 0 — closest to a destroyed tab)"))
    sweep(ctx, :rst)
  end

  # DISPLACEMENT. If the boundary is "the server holds the complete request",
  # then holding the BODY back by D ms must move the boundary by D. The kill
  # offset is held FIXED at 40ms and D is varied across it: same wall-clock
  # abort, opposite verdict, driven only by a knob this harness controls. A
  # boundary that does not move under that knob is a correlation, not a
  # mechanism. The last row re-crosses the moved boundary to show it is a
  # boundary and not simply "D=100 never works".
  test "displacement: holding the body back moves the boundary with it", ctx do
    emit(banner(ctx, "DISPLACEMENT — body held D ms, kill at fixed offset"))
    emit(table_header())

    for {t, d} <- [{40, 10}, {40, 25}, {40, 100}, {120, 100}] do
      ctx |> run_row({:delayed_body, d}, t, :rst) |> emit_row()
    end
  end

  # The one asymmetry the coarse sweep found: RST@+0ms loses the request
  # outright where FIN@+0ms does not. Two questions follow, and both change
  # what the finding licenses: how WIDE is the losing window, and is the loss
  # about the accept or about the read? The settled rows answer the second by
  # removing the accept from the race.
  test "the RST losing window: how wide, and is it the accept or the read", ctx do
    emit(banner(ctx, "RST SUB-MILLISECOND BOUNDARY"))
    emit(table_header())

    for offset <- [0, 0.1, 0.25, 0.5, 1] do
      ctx |> run_row(:after_full, offset, :rst) |> emit_row()
    end

    for offset <- [0, 0.25] do
      ctx |> run_row({:settled, 10}, offset, :rst) |> emit_row()
    end
  end

  defp sweep(ctx, mode) do
    emit(table_header())

    specs = [{:head_only, nil}, {:mid_body, nil}] ++ Enum.map(@offsets, &{:after_full, &1})

    for {kind, offset} <- specs do
      ctx |> run_row(kind, offset, mode) |> emit_row()
    end
  end

  # --- one row ------------------------------------------------------------

  defp run_row(ctx, kind, offset, mode) do
    results = for i <- 1..@n, do: one_attempt(ctx, kind, offset, mode, i)

    %{
      kind: kind,
      offset: offset,
      mode: mode,
      n: @n,
      persisted: Enum.count(results, & &1.persisted),
      on_wire: Enum.count(results, & &1.on_wire)
    }
  end

  defp one_attempt(ctx, kind, offset, mode, i) do
    reset_limiters()
    body = "p954-#{kind_tag(kind)}-#{offset}-#{mode}-#{i}-#{System.unique_integer([:positive])}"

    abort_post(ctx, body, kind, offset, mode)

    # Barrier: a sentinel accepted strictly after the aborted one, plus grace.
    sentinel = "p954-sentinel-#{System.unique_integer([:positive])}"
    reset_limiters()
    assert complete_post(ctx, sentinel) == 201, "sentinel refused — the door is not open"
    assert await_row(ctx, sentinel, 5_000), "sentinel never landed — barrier is not a barrier"
    Process.sleep(@grace_ms)

    %{persisted: row?(ctx, body), on_wire: wire?(ctx, body)}
  end

  defp kind_tag({:delayed_body, d}), do: "delay#{d}"
  defp kind_tag({:settled, s}), do: "settled#{s}"
  defp kind_tag(kind), do: to_string(kind)

  # --- the client ---------------------------------------------------------

  defp abort_post(ctx, body, kind, offset, mode) do
    payload = Jason.encode!(%{"body" => body})
    head = request_head(ctx, byte_size(payload))
    sock = connect(ctx.port)

    case kind do
      :head_only ->
        :ok = :gen_tcp.send(sock, head)

      :mid_body ->
        half = binary_part(payload, 0, div(byte_size(payload), 2))
        :ok = :gen_tcp.send(sock, head <> half)

      :after_full ->
        :ok = :gen_tcp.send(sock, head <> payload)
        sleep_precise(offset)

      # Same as `:after_full`, but the connection is left to settle first so
      # the server's accept has certainly completed before any byte is sent.
      # Discriminates the two candidate mechanisms behind an RST@+0ms loss:
      # a request discarded because accept had not finished, versus one
      # discarded because the handler had not yet READ it.
      {:settled, settle} ->
        sleep_precise(settle)
        :ok = :gen_tcp.send(sock, head <> payload)
        sleep_precise(offset)

      # Kill lands before the body was ever due: the server is still holding
      # an incomplete request.
      {:delayed_body, d} when offset <= d ->
        :ok = :gen_tcp.send(sock, head)
        sleep_precise(offset)

      {:delayed_body, d} ->
        :ok = :gen_tcp.send(sock, head)
        sleep_precise(d)
        :ok = :gen_tcp.send(sock, payload)
        sleep_precise(offset - d)
    end

    kill(sock, mode)
  end

  defp complete_post(ctx, body) do
    payload = Jason.encode!(%{"body" => body})
    sock = connect(ctx.port)
    :ok = :gen_tcp.send(sock, request_head(ctx, byte_size(payload)) <> payload)
    status = read_status(sock)
    :gen_tcp.close(sock)
    status
  end

  defp request_head(ctx, len) do
    """
    POST /networks/#{ctx.network.slug}/channels/%23#{String.trim_leading(@channel, "#")}/messages HTTP/1.1\r
    Host: 127.0.0.1\r
    Authorization: Bearer #{ctx.token}\r
    Content-Type: application/json\r
    Content-Length: #{len}\r
    Connection: close\r
    \r
    """
  end

  defp connect(port) do
    {:ok, sock} =
      :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false, packet: :raw, nodelay: true])

    sock
  end

  # FIN is a graceful half-close; RST is what `linger: {true, 0}` turns close
  # into — the abrupt teardown a destroyed document is closer to.
  defp kill(sock, :fin), do: :gen_tcp.close(sock)

  defp kill(sock, :rst) do
    :ok = :inet.setopts(sock, [{:linger, {true, 0}}])
    :gen_tcp.close(sock)
  end

  defp read_status(sock) do
    {:ok, data} = :gen_tcp.recv(sock, 0, 5_000)
    [_, code | _] = data |> String.split("\r\n") |> hd() |> String.split(" ")
    String.to_integer(code)
  end

  # `Process.sleep/1` cannot express 0 and rounds up at the millisecond; the
  # sharpest sample in the sweep is exactly 0, so spin instead of sleeping.
  defp sleep_precise(0), do: true

  defp sleep_precise(ms) do
    spin(System.monotonic_time(:microsecond) + ms * 1000)
  end

  defp spin(deadline) do
    if System.monotonic_time(:microsecond) >= deadline, do: true, else: spin(deadline)
  end

  # --- observation --------------------------------------------------------

  defp row?(ctx, body) do
    query = from(m in Scrollback.Message, where: m.network_id == ^ctx.network.id and m.body == ^body)

    Repo.aggregate(query, :count) > 0
  end

  defp wire?(ctx, body) do
    ctx.irc |> IRCServer.sent_lines() |> Enum.any?(&String.contains?(&1, body))
  end

  defp await_row(ctx, body, timeout) when timeout > 0 do
    if row?(ctx, body) do
      true
    else
      Process.sleep(25)
      await_row(ctx, body, timeout - 25)
    end
  end

  defp await_row(_, _, _), do: false

  defp baseline_latency(ctx) do
    for _ <- 1..20 do
      reset_limiters()
      t0 = System.monotonic_time(:microsecond)
      201 = complete_post(ctx, "p954-baseline-#{System.unique_integer([:positive])}")
      (System.monotonic_time(:microsecond) - t0) / 1000
    end
    |> Enum.sort()
    |> then(&%{min: hd(&1), p50: Enum.at(&1, 10), max: List.last(&1)})
  end

  # Both the #340 per-(subject, network) send bucket and the #630 coarse
  # request budget live in the same ETS table; a sweep would otherwise drain
  # them and — worse — the budget SEVERS the bearer on the crossing, turning
  # every later row into a false "not persisted".
  defp reset_limiters, do: :ets.delete_all_objects(TokenBucket.table_name())

  # --- output -------------------------------------------------------------

  defp banner(ctx, what) do
    {:ok, host} = :inet.gethostname()
    system = :system_version |> :erlang.system_info() |> to_string() |> String.trim()

    """

    ================ #954 ABORT-PERSISTENCE — #{what} ================
    host     : #{host}
    system   : #{system}
    N/row    : #{@n}
    baseline unaborted POST round-trip (ms): #{inspect(baseline_latency(ctx))}
    """
  end

  defp table_header do
    "| abort point                | close | N  | persisted | on wire |\n" <>
      "|----------------------------|-------|----|-----------|---------|"
  end

  defp emit_row(r) do
    emit(
      "| #{String.pad_trailing(label(r), 26)} | #{String.pad_trailing(to_string(r.mode), 5)} " <>
        "| #{String.pad_trailing(to_string(r.n), 2)} | #{String.pad_trailing("#{r.persisted}/#{r.n}", 9)} " <>
        "| #{String.pad_trailing("#{r.on_wire}/#{r.n}", 7)} |"
    )
  end

  defp label(%{kind: :head_only}), do: "headers only, no body"
  defp label(%{kind: :mid_body}), do: "mid-body (half sent)"
  defp label(%{kind: :after_full, offset: o}), do: "+#{o}ms after last byte"
  defp label(%{kind: {:delayed_body, d}, offset: o}), do: "body @#{d}ms, kill @#{o}ms"
  defp label(%{kind: {:settled, s}, offset: o}), do: "settle #{s}ms, then +#{o}ms"

  # ExUnit runs with `capture_log: true`, so the Logger copy is for the run
  # artifact; `IO.puts` is what the operator watching the run actually sees.
  defp emit(text) do
    IO.puts(text)
    Logger.info(text)
  end

  defp start_listener do
    port = free_port()

    {:ok, _} =
      start_supervised({Bandit, plug: GrappaWeb.Endpoint, scheme: :http, port: port, ip: {127, 0, 0, 1}})

    port
  end

  defp free_port do
    {:ok, l} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}])
    {:ok, p} = :inet.port(l)
    :ok = :gen_tcp.close(l)
    p
  end
end
