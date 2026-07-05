defmodule Grappa.WSPresence do
  @moduledoc """
  Per-user WS presence + per-pid PWA visibility tracker — owns the live
  Phoenix WebSocket pids per user AND each pid's reported foreground
  visibility, so `Session.Server` can drive auto-away and
  `Grappa.Push.Triggers` can suppress foreground pushes (CLAUDE.md
  "Process state stays small; anything that must survive a crash goes
  in Ecto, not GenServer state").

  ## Responsibility

  One named `GenServer` (`:permanent`, single-node) that owns
  `%{user_name => %{pid() => :visible | :hidden}}`. Each entry is a
  live socket pid (monitored) mapped to the last visibility the page
  reported over the `"visibility"` channel event. When the set of
  VISIBLE devices for a user transitions, it notifies interested
  listeners so `Session.Server`s can schedule / cancel their 30s
  auto-away debounce.

  ## Why visibility, not connection count (#182)

  iOS PWAs hold the WebSocket open while backgrounded, so a live socket
  is NOT proof the user is looking at the app. The page reports its real
  foreground state via `document.visibilitychange` (reliable on iOS,
  unlike the SW's `clients.matchAll`). Auto-away and push-suppression
  both key off "is ANY device VISIBLE", never the raw connection count.

  ## One raw signal, two consumers, two timings

    * **Auto-away FSM** (`Session.Server`) — DEBOUNCED 30s. Transitions
      on the `:ws_visible` / `:ws_all_hidden` lifecycle events below.
    * **Push suppression** (`Grappa.Push.Triggers`) — RAW/IMMEDIATE.
      Reads `any_visible?/1` synchronously at message time, no debounce
      (a debounced gate would miss mentions right after you set the
      phone down).

  ## Lifecycle events

  Fired to `notify_pid` (tests) or every `Session.Server` for the user
  (production) on the `any_visible?/1` TRANSITION for that user:

  - **`:ws_visible`** — a device became visible when none was before
    (`any_visible?` false → true). Signals cancellation of any pending
    auto-away debounce + unaway.
  - **`:ws_all_hidden`** — the last visible device hid or left
    (`any_visible?` true → false, sockets may still be connected but
    backgrounded). Session.Servers schedule a 30s debounce that fires
    `set_auto_away`.

  Registering a socket defaults it to `:hidden`, so `register/2` alone
  never fires `:ws_visible` — a just-connected device is assumed
  backgrounded until it reports otherwise (deliver-leaning: erring
  toward `:hidden` never suppresses a wanted push; the SW re-check
  backstops a false delivery). The page reports its true visibility via
  `set_visibility/3` right after the user-channel join.

  ## Fan-out problem avoided

  Each Phoenix socket connects once (one `UserSocket.connect/3` call),
  but joins MULTIPLE topics (one user-level + N per-channel). Tracking at
  the SOCKET pid level (not channel terminate) means one DOWN event per
  real WS lifecycle regardless of how many channels are joined.

  ## `notify_pid` in tests

  In production, `notify_pid` is not passed to `register/2` — instead
  the WSPresence module looks up all `Session.Server`s for the user via
  `Grappa.SessionRegistry` (through PubSub) and sends the event to each.
  Tests use `register_with_notify/3` with an explicit `notify_pid:` to
  assert notifications without needing live Session.Servers.

  ## client_closing/2 — pagehide immediate-away path

  `client_closing/2` is the "socket is about to close" hint that cicchetto
  sends via the `client_closing` channel event on `pagehide` /
  `beforeunload`. The closing tab is definitely not visible, so
  WSPresence marks the pid `:hidden` immediately; if that was the last
  visible device it fires `:ws_all_hidden` without waiting for the real
  pid `:DOWN` (which can lag the TCP teardown). The subsequent `:DOWN`
  removes the pid and is idempotent (already `:hidden` → no re-fire).

  ## Crash isolation

  A crash in WSPresence (which is `:permanent`) causes a restart with
  empty state. The live sockets are NOT re-registered (register only
  happens at `UserSocket.connect`), and `set_visibility/3` on an
  untracked pid is a no-op — so a visibility report does NOT recover
  tracking; only a socket RECONNECT (a fresh `register/2`) does. Until
  then every device reads as untracked → `any_visible?/1` false → pushes
  deliver (SW backstops) and auto-away for current sessions is lost.
  Acceptable degradation (same class as the pre-#182 reset).
  Session.Servers are unaffected (no link to WSPresence).

  ## Test isolation

  Application-wide singleton (`name: __MODULE__`) shared across the
  entire `mix test` run. The `sockets` map is keyed by `user_name`;
  two concurrent tests reusing the same fixture name would inherit
  each other's pid maps, producing spurious lifecycle notifications.
  `config :ex_unit, max_cases: 1` in `config/test.exs` is the global
  guard. Tests touching this module MUST stay `async: false` so the
  same constraint applies even if `max_cases` is later relaxed for a
  faster lane.
  """
  use GenServer

  use Boundary, top_level?: true, deps: [Grappa.PubSub]

  alias Grappa.PubSub.Topic

  require Logger

  # Test-only atom guarding `reset_for_test/0` — ONLY compiled in test mix env.
  # (A `@test_only` marker is the documented way to keep test helpers alive
  # without weakening the production contract.)

  # ---------------------------------------------------------------------------
  # State shape
  # ---------------------------------------------------------------------------

  # `sockets` — %{user_name => %{pid() => :visible | :hidden}}
  # `notify_pids` — %{user_name => pid()} for test overrides; in production nil
  # `refs_to_user` — %{reference() => user_name} for monitor → user lookup

  defstruct sockets: %{}, notify_pids: %{}, refs_to_user: %{}

  @typedoc "Per-pid reported PWA foreground visibility."
  @type visibility :: :visible | :hidden

  @type t :: %__MODULE__{
          sockets: %{String.t() => %{pid() => visibility()}},
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
  Registers a socket pid for `user_name`, defaulting it to `:hidden`.
  Monitors the pid; when it exits, drops it and fires `:ws_all_hidden`
  if it was the last VISIBLE device.

  Registering the same pid twice is idempotent (map key semantics —
  the second call does NOT reset an already-reported visibility).
  """
  @spec register(String.t(), pid()) :: :ok
  def register(user_name, socket_pid)
      when is_binary(user_name) and is_pid(socket_pid) do
    GenServer.call(__MODULE__, {:register, user_name, socket_pid, nil})
  end

  @doc """
  Registers a socket pid for `user_name` with a test-only `notify_pid` override.

  In production, notifications go to `Session.Server`s via PubSub. In tests,
  pass `notify_pid` to receive the lifecycle events (`{:ws_visible, _}` and
  `{:ws_all_hidden, _}`) directly. This avoids needing live Session.Servers
  in unit tests.

  **Test-only.** The `notify_pid` param must not be used in production code.
  """
  @spec register_with_notify(String.t(), pid(), pid()) :: :ok
  def register_with_notify(user_name, socket_pid, notify_pid)
      when is_binary(user_name) and is_pid(socket_pid) and is_pid(notify_pid) do
    GenServer.call(__MODULE__, {:register, user_name, socket_pid, notify_pid})
  end

  @doc """
  Records the PWA foreground visibility a page reported for its socket
  `socket_pid`. `true` → `:visible`, `false` → `:hidden`.

  Fires `:ws_visible` when this flips the user from no-visible-device to
  at least one, or `:ws_all_hidden` when it hides the last visible
  device. A no-op (no event) when `socket_pid` is not tracked (a race
  with DOWN) or the reported value doesn't change `any_visible?/1`.
  """
  @spec set_visibility(String.t(), pid(), boolean()) :: :ok
  def set_visibility(user_name, socket_pid, visible)
      when is_binary(user_name) and is_pid(socket_pid) and is_boolean(visible) do
    GenServer.call(__MODULE__, {:set_visibility, user_name, socket_pid, visible})
  end

  @doc """
  Returns `true` when at least one of `user_name`'s devices reports the
  PWA is foreground-visible. Read synchronously by `Push.Triggers` to
  suppress the whole push fan-out (RAW, no debounce). `false` for an
  unknown user.
  """
  @spec any_visible?(String.t()) :: boolean()
  def any_visible?(user_name) when is_binary(user_name) do
    GenServer.call(__MODULE__, {:any_visible?, user_name})
  end

  @doc """
  Returns the current number of live WS connections for `user_name`
  (visible or hidden).
  """
  @spec ws_count(String.t()) :: non_neg_integer()
  def ws_count(user_name) when is_binary(user_name) do
    GenServer.call(__MODULE__, {:ws_count, user_name})
  end

  @doc """
  Returns the list of `user_name`s with at least one live WS connection.
  Includes both authenticated users (`user.name`) and visitors
  (`"visitor:" <> visitor.id`) — bucket E web/S5 unified the
  registration so `cic-bundle-changed` reaches every connected tab.

  CP23 S4 B5 — used by the `cic-bundle-changed` admin endpoint to fan
  out the new bundle hash on every connected user's user-topic. Empty
  socket maps (a user previously connected, all sockets dropped) are
  filtered out so callers don't broadcast to dead audiences.
  """
  @spec list_user_names() :: [String.t()]
  def list_user_names do
    GenServer.call(__MODULE__, :list_user_names)
  end

  @doc """
  Immediate-close hint — the socket at `socket_pid` is about to close.

  Marks the pid `:hidden` immediately (a closing tab is not visible). If
  that was the last VISIBLE device, fires `:ws_all_hidden` now rather
  than waiting for the real pid DOWN (which can lag the TCP teardown).
  The subsequent DOWN removes the pid and is idempotent.

  A no-op when `socket_pid` is not tracked for `user_name`.
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
  # Dialyzer sees two clauses depending on Mix.env() at compile time:
  # - test env: returns :ok (from GenServer.call reply)
  # - non-test: raises (no_return)
  # A single @spec cannot capture both, so we suppress the warning
  # rather than lying about the production no_return branch.
  @dialyzer {:nowarn_function, reset_for_test: 0}
  @spec reset_for_test() :: :ok
  if Mix.env() == :test do
    def reset_for_test, do: GenServer.call(__MODULE__, :reset_for_test)
  else
    def reset_for_test do
      raise "reset_for_test/0 is test-only and must not be called in production"
    end
  end

  @doc """
  Test-support: drops `user_name`'s presence entries without touching
  other users. Mirrors `reset_for_test/0` but per-user — used by
  `Grappa.TestSupport.SubjectReset` for seed-user cleanup. Not
  available in prod.

  Removes the user's `sockets` map, demonitors every pid that was
  in it (clearing `refs_to_user`), and drops the `notify_pids` override.
  """
  @dialyzer {:nowarn_function, reset_for_user: 1}
  @spec reset_for_user(String.t()) :: :ok
  if Mix.env() in [:dev, :test] do
    def reset_for_user(user_name) when is_binary(user_name) do
      GenServer.call(__MODULE__, {:reset_for_user, user_name})
    end
  else
    def reset_for_user(_) do
      raise "reset_for_user/1 is dev/test-only and must not be called in production"
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl GenServer
  def init(_) do
    {:ok, %__MODULE__{}}
  end

  @impl GenServer
  def handle_call({:register, user_name, socket_pid, notify_pid}, _, state) do
    existing = Map.get(state.sockets, user_name, %{})
    already_tracked = Map.has_key?(existing, socket_pid)

    # Only monitor if not already tracking this pid. New pids default to
    # :hidden — a just-connected device is assumed backgrounded until it
    # reports otherwise. No visibility event on register: adding a :hidden
    # pid can never flip `any_visible?/1`.
    state1 =
      if already_tracked do
        state
      else
        ref = Process.monitor(socket_pid)
        updated = Map.put(existing, socket_pid, :hidden)

        %{
          state
          | sockets: Map.put(state.sockets, user_name, updated),
            refs_to_user: Map.put(state.refs_to_user, ref, user_name)
        }
      end

    # Store notify_pid override (last write wins — idempotent)
    state2 =
      if notify_pid != nil do
        %{state1 | notify_pids: Map.put(state1.notify_pids, user_name, notify_pid)}
      else
        state1
      end

    {:reply, :ok, state2}
  end

  def handle_call({:set_visibility, user_name, socket_pid, visible}, _, state) do
    existing = Map.get(state.sockets, user_name, %{})

    if Map.has_key?(existing, socket_pid) do
      before? = any_visible_in?(state, user_name)
      updated = Map.put(existing, socket_pid, if(visible, do: :visible, else: :hidden))
      state1 = put_user_sockets(state, user_name, updated)
      after? = any_visible_in?(state1, user_name)
      emit_transition(user_name, before?, after?, state1)
      {:reply, :ok, state1}
    else
      # Untracked pid (register lost / raced with DOWN) — ignore.
      {:reply, :ok, state}
    end
  end

  def handle_call({:any_visible?, user_name}, _, state) do
    {:reply, any_visible_in?(state, user_name), state}
  end

  def handle_call({:ws_count, user_name}, _, state) do
    count =
      state.sockets
      |> Map.get(user_name, %{})
      |> map_size()

    {:reply, count, state}
  end

  def handle_call(:list_user_names, _, state) do
    names =
      state.sockets
      |> Enum.filter(fn {_, m} -> map_size(m) > 0 end)
      |> Enum.map(fn {name, _} -> name end)

    {:reply, names, state}
  end

  def handle_call({:client_closing, user_name, socket_pid}, _, state) do
    existing = Map.get(state.sockets, user_name, %{})

    if Map.has_key?(existing, socket_pid) do
      before? = any_visible_in?(state, user_name)
      # A closing tab is not visible — mark it hidden now. The real pid
      # DOWN removes it later (idempotent).
      updated = Map.put(existing, socket_pid, :hidden)
      state1 = put_user_sockets(state, user_name, updated)
      after? = any_visible_in?(state1, user_name)
      emit_transition(user_name, before?, after?, state1)
      {:reply, :ok, state1}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call(:reset_for_test, _, _) do
    {:reply, :ok, %__MODULE__{}}
  end

  def handle_call({:reset_for_user, user_name}, _, state) do
    # Identify monitor refs belonging to this user
    {user_refs, kept_refs} =
      Enum.split_with(state.refs_to_user, fn {_, name} -> name == user_name end)

    # Demonitor the user's socket pids
    Enum.each(user_refs, fn {ref, _} -> Process.demonitor(ref, [:flush]) end)

    new_state = %{
      state
      | sockets: Map.delete(state.sockets, user_name),
        notify_pids: Map.delete(state.notify_pids, user_name),
        refs_to_user: Map.new(kept_refs)
    }

    {:reply, :ok, new_state}
  end

  @impl GenServer
  def handle_info({:DOWN, ref, :process, pid, _}, state) do
    case Map.get(state.refs_to_user, ref) do
      nil ->
        {:noreply, state}

      user_name ->
        state1 = %{state | refs_to_user: Map.delete(state.refs_to_user, ref)}
        existing = Map.get(state1.sockets, user_name, %{})
        before? = any_visible_in?(state1, user_name)
        updated = Map.delete(existing, pid)
        state2 = put_user_sockets(state1, user_name, updated)
        after? = any_visible_in?(state2, user_name)
        # Only a VISIBLE pid leaving can flip any_visible? true→false. A
        # hidden pid dying (or one already removed by client_closing) is a
        # no-op transition — no duplicate :ws_all_hidden.
        emit_transition(user_name, before?, after?, state2)
        {:noreply, state2}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec put_user_sockets(t(), String.t(), %{pid() => visibility()}) :: t()
  defp put_user_sockets(state, user_name, user_sockets) do
    %{state | sockets: Map.put(state.sockets, user_name, user_sockets)}
  end

  @spec any_visible_in?(t(), String.t()) :: boolean()
  defp any_visible_in?(state, user_name) do
    state.sockets
    |> Map.get(user_name, %{})
    |> Enum.any?(fn {_, vis} -> vis == :visible end)
  end

  # Fire the visibility lifecycle event when `any_visible?/1` transitions
  # for `user_name` (the single crux of the auto-away generalization).
  @spec emit_transition(String.t(), boolean(), boolean(), t()) :: :ok
  defp emit_transition(user_name, before?, after?, state) do
    cond do
      not before? and after? -> notify(user_name, {:ws_visible, user_name}, state)
      before? and not after? -> notify(user_name, {:ws_all_hidden, user_name}, state)
      true -> :ok
    end
  end

  # In production: find all Session.Servers for the user via the registry and
  # send the event to each. In tests: use the stored notify_pid override.
  @spec notify(String.t(), term(), t()) :: :ok
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

  @typep ws_event :: {:ws_visible, String.t()} | {:ws_all_hidden, String.t()}

  @spec notify_sessions(String.t(), ws_event()) :: :ok
  defp notify_sessions(user_name, event) do
    # UserSocket assigns user_name (not user_id); the session registry uses
    # {:user, user_id} as the subject. We pass user_name through to
    # Session.Server via Grappa.PubSub instead of resolving the id here.
    :ok =
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        Topic.ws_presence(user_name),
        event
      )
  end
end
