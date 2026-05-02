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

  `wait_for_line/3` polls `sent_lines/1` until a predicate matches or a
  timeout fires. Use this to assert the client sent a particular line
  WITHOUT racing on `:sys.get_state` of the client GenServer or relying
  on `Process.sleep` constants. Returns `{:ok, matched_line}` or
  `{:error, :timeout}`.
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
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait_for_line(server, predicate, deadline)
  end

  defp do_wait_for_line(server, predicate, deadline) do
    case Enum.find(sent_lines(server), predicate) do
      nil ->
        if System.monotonic_time(:millisecond) >= deadline do
          {:error, :timeout}
        else
          Process.sleep(10)
          do_wait_for_line(server, predicate, deadline)
        end

      line ->
        {:ok, line}
    end
  end

  ## GenServer

  @impl GenServer
  def init(handler) do
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
       sent: []
     }}
  end

  @impl GenServer
  def handle_call(:port, _, state), do: {:reply, state.port, state}
  def handle_call(:sent_lines, _, state), do: {:reply, Enum.reverse(state.sent), state}

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
    {:noreply, new_state}
  end

  def handle_info({:tcp_closed, _}, state), do: {:noreply, %{state | sock: nil}}
end
