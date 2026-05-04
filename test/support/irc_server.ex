defmodule Grappa.IRCServer do
  @moduledoc """
  In-process fake IRC server for testing `Grappa.IRC.Client` and (via
  `Grappa.Session.Server` tests) the broader supervised IRC stack.

  Listens on an ephemeral TCP port (`port/1` returns the assigned
  number after `start_link/1` returns), accepts ONE client connection,
  buffers every line the client writes (`sent_lines/1`), and lets
  tests both react to inbound lines via a handler callback and push
  server-originated lines via `feed/2`.

  ## Handler

  `start_link(handler)` takes a 2-arity function:

      handler.(handler_state, inbound_line)
      → {:reply, line_or_nil, new_handler_state}
      | :ignore

  A `:reply` with a non-nil binary writes that binary back to the
  socket immediately. A `:reply` with `nil` updates handler state but
  sends nothing. `:ignore` is a no-op (handler state unchanged).

  Splitting handler logic from socket I/O keeps tests readable —
  scripted PONG-on-PING + JOIN-ack patterns stay declarative.

  ## Synchronization

  `wait_for_line/3` blocks until a predicate matches a sent line or a
  timeout fires. Use this to assert the client sent a particular line
  WITHOUT racing on `:sys.get_state` of the client GenServer or relying
  on `Process.sleep` constants. Returns `{:ok, matched_line}` or
  `{:error, :timeout}`.

  Implementation (M-irc-2): the wait is a single GenServer call that
  either replies immediately (the predicate matches some buffered line)
  or registers a `{ref, predicate, from}` waiter on server state and
  returns `:noreply`. When a new inbound line arrives, the handler
  walks the waiter list and `GenServer.reply/2`s every match. A
  `Process.send_after/3` timer fires `{:wait_timeout, ref}` to drop
  the waiter and reply `{:error, :timeout}` at the deadline.

  This replaces the previous 10ms-poll busy-wait — collides with the
  mailbox-blocking discipline established prod-side, and an idle waiter
  no longer wakes up just to re-call the server.
  """
  use GenServer

  @type handler_state :: term()
  @type handler ::
          (handler_state(), binary() ->
             {:reply, binary() | nil, handler_state()} | :ignore)

  ## API

  @spec start_link(handler()) :: GenServer.on_start()
  def start_link(handler) when is_function(handler, 2) do
    GenServer.start_link(__MODULE__, handler)
  end

  @spec port(pid()) :: :inet.port_number()
  def port(server), do: GenServer.call(server, :port)

  @spec sent_lines(pid()) :: [binary()]
  def sent_lines(server), do: GenServer.call(server, :sent_lines)

  @spec feed(pid(), iodata()) :: :ok
  def feed(server, line), do: GenServer.cast(server, {:feed, line})

  @spec wait_for_line(pid(), (binary() -> boolean()), pos_integer()) ::
          {:ok, binary()} | {:error, :timeout}
  def wait_for_line(server, predicate, timeout \\ 1_000)
      when is_function(predicate, 1) and is_integer(timeout) and timeout > 0 do
    # Outer call timeout is `timeout + 100` so the server-side timer
    # always fires first and the call returns `{:error, :timeout}`
    # cleanly rather than as a `GenServer.call/3` exit.
    GenServer.call(server, {:wait_for, predicate, timeout}, timeout + 100)
  end

  ## GenServer

  @impl GenServer
  def init(handler) do
    # L-irc-2: trap exits so `terminate/2` runs on link-driven shutdown
    # too (not just normal `:stop`). Without this the listen socket and
    # accepted client socket leak when the test process exits — Eaccept
    # cascades on the next test if the OS reuses the same ephemeral
    # port faster than the kernel reaps the dead listener.
    Process.flag(:trap_exit, true)

    {:ok, listen} =
      :gen_tcp.listen(0, [:binary, packet: :line, active: false, reuseaddr: true])

    {:ok, port} = :inet.port(listen)
    me = self()

    # 30s accept budget. Sized for cluster-wide test contention: the
    # `IRCServer` is `start_link`'d at the top of a test, the test then
    # does its setup work (DB inserts via Sandbox, credential binding,
    # `Bootstrap.run/0` or `Session.start_session/3`) before the
    # `Session.Server`'s `handle_continue(:connect, _)` reaches this
    # acceptor. Under parallel-test load on slower hardware (Raspberry Pi
    # 5 host, container-virtualized BEAM), that setup can stretch past
    # the original 5s budget, causing the acceptor to timeout silently;
    # the subsequent `Client` connect then hits `:econnrefused`, the
    # session crashes, and the test's `wait_for_line` for any expected
    # client→server line times out with `{:error, :timeout}`. Bumping
    # to 30s absorbs the contention without masking real bugs (a test
    # that genuinely never reaches the connect path will still timeout
    # — just at 30s instead of 5s, which is fine for a CI gate).
    spawn_link(fn ->
      case :gen_tcp.accept(listen, 30_000) do
        {:ok, sock} ->
          :ok = :gen_tcp.controlling_process(sock, me)
          send(me, {:accepted, sock})

        {:error, _} ->
          :ok
      end
    end)

    {:ok,
     %{
       listen: listen,
       port: port,
       sock: nil,
       handler: handler,
       handler_state: %{},
       sent: [],
       # M-irc-2: waiters is a list of `{ref, predicate, from}`. The
       # ref ties a waiter to its `Process.send_after/3` timeout token
       # so the timeout fires can find-and-drop the right entry. List
       # is fine — wait_for_line concurrency is bounded by the test
       # writing the assertion (typically 1, occasionally a handful).
       waiters: []
     }}
  end

  @impl GenServer
  def handle_call(:port, _, state), do: {:reply, state.port, state}
  def handle_call(:sent_lines, _, state), do: {:reply, Enum.reverse(state.sent), state}

  def handle_call({:wait_for, predicate, timeout}, from, state) do
    # Eagerly check buffered lines first — a predicate that already
    # matches replies synchronously without ever touching the timer.
    # Iterate in arrival order so the FIRST matching line wins (state.sent
    # is reversed-newest-first).
    case Enum.find(Enum.reverse(state.sent), predicate) do
      nil ->
        ref = make_ref()
        Process.send_after(self(), {:wait_timeout, ref}, timeout)
        {:noreply, %{state | waiters: [{ref, predicate, from} | state.waiters]}}

      line ->
        {:reply, {:ok, line}, state}
    end
  end

  @impl GenServer
  def handle_cast({:feed, _}, %{sock: nil} = state), do: {:noreply, state}

  def handle_cast({:feed, line}, state) do
    :ok = :gen_tcp.send(state.sock, line)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:accepted, sock}, state) do
    :ok = :inet.setopts(sock, active: :once)
    {:noreply, %{state | sock: sock}}
  end

  def handle_info({:tcp, sock, line}, state) do
    new_sent = [line | state.sent]

    new_state =
      case state.handler.(state.handler_state, line) do
        {:reply, nil, new_inner} ->
          %{state | sent: new_sent, handler_state: new_inner}

        {:reply, outbound, new_inner} when is_binary(outbound) ->
          :ok = :gen_tcp.send(sock, outbound)
          %{state | sent: new_sent, handler_state: new_inner}

        :ignore ->
          %{state | sent: new_sent}
      end

    :ok = :inet.setopts(sock, active: :once)
    {:noreply, notify_waiters(new_state, line)}
  end

  def handle_info({:tcp_closed, _}, state), do: {:noreply, %{state | sock: nil}}

  # L-irc-2: with `:trap_exit, true` the spawn_link'd acceptor's
  # normal exit (and any future linked process) lands in the mailbox
  # as `{:EXIT, pid, reason}` instead of crashing this GenServer.
  # Treat both `:normal` and abnormal reasons as "the linked helper
  # is gone" — there's nothing to recover; the server keeps running
  # until its own owner shuts it down. A `:noreply` swallow keeps
  # the GenServer alive without requiring per-helper recovery code.
  def handle_info({:EXIT, _, _}, state), do: {:noreply, state}

  # M-irc-2: timer fired before any line satisfied the predicate. Drop
  # the waiter and reply timeout. If the entry is gone (already replied
  # via notify_waiters/2 then the late timer arrives), this is a no-op.
  def handle_info({:wait_timeout, ref}, state) do
    case Enum.split_with(state.waiters, fn {r, _, _} -> r == ref end) do
      {[{^ref, _, from}], rest} ->
        GenServer.reply(from, {:error, :timeout})
        {:noreply, %{state | waiters: rest}}

      {[], _} ->
        {:noreply, state}
    end
  end

  # Walk the waiter list against the freshly-arrived line. Replies to
  # every matching waiter and removes them. Predicates are pure (test
  # writers' contract) so calling each once per arrival is safe.
  defp notify_waiters(%{waiters: waiters} = state, line) do
    {matched, remaining} = Enum.split_with(waiters, fn {_, pred, _} -> pred.(line) end)

    Enum.each(matched, fn {_, _, from} ->
      GenServer.reply(from, {:ok, line})
    end)

    %{state | waiters: remaining}
  end

  # L-irc-2: close both sockets on shutdown so the OS reaps the
  # listener + accepted client cleanly. Pairs with `Process.flag(:trap_exit,
  # true)` in `init/1` — under abnormal exit (test process linked to
  # this server crashes mid-flow) the link signal lands here instead
  # of vanishing. The two `if` guards handle the pre-accept window
  # (`sock` is nil) and a post-`:tcp_closed` state (also nil) without
  # raising on a `:gen_tcp.close(nil)` call.
  @impl GenServer
  def terminate(_, %{listen: listen, sock: sock}) do
    if listen, do: :gen_tcp.close(listen)
    if sock, do: :gen_tcp.close(sock)
    :ok
  end
end
