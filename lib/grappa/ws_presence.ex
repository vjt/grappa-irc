defmodule Grappa.WSPresence do
  @moduledoc """
  WS-connection counter per user — tracks live Phoenix WebSocket pids so
  `Session.Server` can implement auto-away (CLAUDE.md "Process state stays
  small; anything that must survive a crash goes in Ecto, not GenServer
  state").

  ## Responsibility

  One named `GenServer` (`:permanent`, single-node) that owns a map of
  `%{user_name => MapSet.t(pid())}`. When all socket pids for a user
  disappear (either via natural process exit or the explicit
  `client_closing/2` hint), it notifies interested listeners so
  `Session.Server`s can schedule their 30s auto-away debounce.

  ## Lifecycle events

  - **`:ws_connected`** — sent to `notify_pid` when the FIRST socket for
    a user is registered (count 0 → 1). Signals cancellation of any
    pending auto-away debounce timer in interested `Session.Server`s.
  - **`:ws_all_disconnected`** — sent to `notify_pid` when the LAST socket
    for a user goes away (count N → 0). Session.Servers that receive this
    schedule a 30s debounce timer that fires `set_auto_away`.

  ## Fan-out problem avoided

  Each Phoenix socket connects once (one `UserSocket.connect/3` call),
  but joins MULTIPLE topics (one user-level + N per-channel). Tracking at
  the SOCKET pid level (not channel terminate) means one DOWN event per
  real WS lifecycle regardless of how many channels are joined. This
  avoids N decrements per single disconnect.

  ## `notify_pid` in tests

  In production, `notify_pid` is not passed to `register/2` — instead
  the WSPresence module looks up all `Session.Server`s for the user via
  `Grappa.SessionRegistry` and sends the event to each. Tests use
  `register/3` with an explicit `notify_pid:` to assert notifications
  without needing live Session.Servers.

  ## client_closing/2 — pagehide immediate-away path

  `client_closing/2` is the "socket is about to close" hint that cicchetto
  sends via the `client_closing` channel event on `pagehide` / `beforeunload`.
  If the given socket pid is the LAST one for the user, WSPresence fires
  `:ws_all_disconnected` immediately (no debounce). The subsequent real pid
  `:DOWN` is handled idempotently (already removed from the set).

  ## Crash isolation

  A crash in WSPresence (which is `:permanent`) causes a restart with empty
  state — auto-away for current sessions is lost until the user next
  disconnects. Session.Servers are unaffected (no link to WSPresence).
  """
  use GenServer

  use Boundary, top_level?: true, deps: [Grappa.PubSub]

  require Logger

  # Test-only atom guarding `reset_for_test/0` — ONLY compiled in test mix env.
  # (A `@test_only` marker is the documented way to keep test helpers alive
  # without weakening the production contract.)

  # ---------------------------------------------------------------------------
  # State shape
  # ---------------------------------------------------------------------------

  # `sockets` — %{user_name => MapSet.t(pid())}
  # `notify_pids` — %{user_name => pid()} for test overrides; in production nil
  # `refs_to_user` — %{reference() => user_name} for monitor → user lookup

  @type state :: %{
          sockets: %{String.t() => MapSet.t(pid())},
          notify_pids: %{String.t() => pid()},
          refs_to_user: %{reference() => String.t()}
        }

  # ---------------------------------------------------------------------------
  # API
  # ---------------------------------------------------------------------------

  @doc """
  Starts the WSPresence GenServer as a named singleton. Used by the
  application supervision tree.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) when is_list(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Registers a socket pid for `user_name`. Monitors the pid; when it exits,
  decrements the count and fires `:ws_all_disconnected` if the set becomes
  empty.

  Registering the same pid twice is idempotent (MapSet semantics).
  """
  @spec register(String.t(), pid()) :: :ok
  def register(user_name, socket_pid)
      when is_binary(user_name) and is_pid(socket_pid) do
    GenServer.call(__MODULE__, {:register, user_name, socket_pid, nil})
  end

  @doc """
  Registers a socket pid for `user_name` with a test-only `notify_pid` override.

  In production, notifications go to `Session.Server`s via PubSub. In tests,
  pass `notify_pid` to receive the lifecycle events (`{:ws_connected, _}` and
  `{:ws_all_disconnected, _}`) directly. This avoids needing live Session.Servers
  in unit tests.

  **Test-only.** The `notify_pid` param must not be used in production code.
  """
  @spec register_with_notify(String.t(), pid(), pid()) :: :ok
  def register_with_notify(user_name, socket_pid, notify_pid)
      when is_binary(user_name) and is_pid(socket_pid) and is_pid(notify_pid) do
    GenServer.call(__MODULE__, {:register, user_name, socket_pid, notify_pid})
  end

  @doc """
  Returns the current number of live WS connections for `user_name`.
  """
  @spec ws_count(String.t()) :: non_neg_integer()
  def ws_count(user_name) when is_binary(user_name) do
    GenServer.call(__MODULE__, {:ws_count, user_name})
  end

  @doc """
  Immediate-close hint — the socket at `socket_pid` is about to close.

  If this is the last socket for `user_name`, fires `:ws_all_disconnected`
  immediately (bypassing the 30s debounce that the normal pid-DOWN path
  would use via the `Session.Server` timer). The subsequent real pid DOWN
  is handled idempotently.

  If other sockets remain for the user, this is a no-op.
  """
  @spec client_closing(String.t(), pid()) :: :ok
  def client_closing(user_name, socket_pid)
      when is_binary(user_name) and is_pid(socket_pid) do
    GenServer.call(__MODULE__, {:client_closing, user_name, socket_pid})
  end

  @doc """
  Resets WSPresence state to empty. **Test-only** — only callable in the
  test environment. Panics in production via the test-env guard.
  """
  @spec reset_for_test() :: :ok
  if Mix.env() == :test do
    def reset_for_test, do: GenServer.call(__MODULE__, :reset_for_test)
  else
    def reset_for_test do
      raise "reset_for_test/0 is test-only and must not be called in production"
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl GenServer
  def init(_opts) do
    {:ok,
     %{
       sockets: %{},
       notify_pids: %{},
       refs_to_user: %{}
     }}
  end

  @impl GenServer
  def handle_call({:register, user_name, socket_pid, notify_pid}, _from, state) do
    existing_set = Map.get(state.sockets, user_name, MapSet.new())
    already_tracked = MapSet.member?(existing_set, socket_pid)

    # Only monitor if not already tracking this pid
    state =
      if already_tracked do
        state
      else
        ref = Process.monitor(socket_pid)
        updated_set = MapSet.put(existing_set, socket_pid)

        state
        |> put_in([:sockets, user_name], updated_set)
        |> put_in([:refs_to_user, ref], user_name)
      end

    # Store notify_pid override (last write wins — idempotent)
    state =
      if notify_pid != nil do
        put_in(state, [:notify_pids, user_name], notify_pid)
      else
        state
      end

    # Fire ws_connected only when going from 0 to 1
    if not already_tracked and MapSet.size(existing_set) == 0 do
      notify(user_name, {:ws_connected, user_name}, state)
    end

    {:reply, :ok, state}
  end

  def handle_call({:ws_count, user_name}, _from, state) do
    count =
      state.sockets
      |> Map.get(user_name, MapSet.new())
      |> MapSet.size()

    {:reply, count, state}
  end

  def handle_call({:client_closing, user_name, socket_pid}, _from, state) do
    existing_set = Map.get(state.sockets, user_name, MapSet.new())

    # Is this the last one?
    remaining = MapSet.delete(existing_set, socket_pid)

    if MapSet.size(remaining) == 0 and MapSet.member?(existing_set, socket_pid) do
      # Remove from sockets immediately (pid DOWN will be idempotent)
      state = put_in(state, [:sockets, user_name], remaining)
      notify(user_name, {:ws_all_disconnected, user_name}, state)
      {:reply, :ok, state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call(:reset_for_test, _from, _state) do
    {:reply, :ok, %{sockets: %{}, notify_pids: %{}, refs_to_user: %{}}}
  end

  @impl GenServer
  def handle_info({:DOWN, ref, :process, pid, _reason}, state) do
    case Map.get(state.refs_to_user, ref) do
      nil ->
        {:noreply, state}

      user_name ->
        state = update_in(state, [:refs_to_user], &Map.delete(&1, ref))
        existing_set = Map.get(state.sockets, user_name, MapSet.new())
        updated_set = MapSet.delete(existing_set, pid)
        state = put_in(state, [:sockets, user_name], updated_set)

        # Only fire ws_all_disconnected if we actually removed the pid from the set
        # (i.e., the pid was still tracked). If client_closing/2 already removed it
        # and fired the notification, the set was already empty before this DOWN —
        # the pid was no longer in `existing_set`, so `updated_set == existing_set`.
        # That idempotency check prevents a double notification.
        if MapSet.member?(existing_set, pid) and MapSet.size(updated_set) == 0 do
          notify(user_name, {:ws_all_disconnected, user_name}, state)
        end

        {:noreply, state}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # In production: find all Session.Servers for the user via the registry and
  # send the event to each. In tests: use the stored notify_pid override.
  @spec notify(String.t(), term(), state()) :: :ok
  defp notify(user_name, event, state) do
    case Map.get(state.notify_pids, user_name) do
      nil ->
        # Production path: fan out to all Session.Servers for this user.
        notify_sessions(user_name, event)

      pid when is_pid(pid) ->
        # Test override path
        send(pid, event)
        :ok
    end
  end

  @spec notify_sessions(String.t(), term()) :: :ok
  defp notify_sessions(user_name, event) do
    # Match all {:session, {:user, _}, network_id} entries for this user_name.
    # We don't have direct access to user_id here — we'd need to look it up.
    # However, UserSocket assigns user_name (not user_id). The session registry
    # uses {:user, user_id} as the subject. We pass user_name through to
    # Session.Server via Grappa.PubSub instead.
    :ok =
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        "grappa:ws_presence:#{user_name}",
        event
      )
  end
end
