defmodule Grappa.SessionStopSessionTest.Holder do
  @moduledoc """
  A stand-in for `Grappa.Session.Server` that occupies a real
  `Grappa.SessionRegistry` session key under the real
  `Grappa.SessionSupervisor`, with the real `restart: :transient`
  policy — the two ingredients #854 is about.

  Two knobs make the restart race DETERMINISTIC instead of scheduler
  luck:

    * `:register_delay_ms` — `start_link/1` runs **in the supervisor's
      own process**, so announcing `{:starting, generation}` before
      sleeping proves the supervisor is *inside* a restart and cannot
      answer any other call (including a `terminate_child/2` or a
      `count_children/1`) until the restarted child has registered.

    * `:refiller` — a process that starts the NEXT generation as a
      supervisor child. The handshake happens inside `terminate/2`, i.e.
      strictly BEFORE this child dies, so the refill call is enqueued at
      the supervisor ahead of anything the stopper sends after observing
      the `:DOWN`. This models an endless restart chase.
  """

  use GenServer, restart: :transient

  alias Grappa.Session.Server

  @registration_attempts 200
  @registration_retry_ms 1
  @handshake_ms 1_000

  def child_spec(opts) do
    %{
      id: {__MODULE__, opts.subject, opts.network_id, opts.generation},
      start: {__MODULE__, :start_link, [opts]},
      restart: :transient
    }
  end

  def start_link(opts) do
    send(opts.observer, {:starting, opts.generation})
    Process.sleep(opts.register_delay_ms)
    register(opts, @registration_attempts)
  end

  # The predecessor's Registry entry is cleaned asynchronously by the
  # Registry process, so a restart can legitimately lose the first
  # attempt at its own key. Retry rather than fail the whole start.
  defp register(_opts, 0), do: {:error, :key_never_freed}

  defp register(opts, attempts) do
    case GenServer.start_link(__MODULE__, opts, name: Server.via(opts.subject, opts.network_id)) do
      {:error, {:already_started, _}} ->
        Process.sleep(@registration_retry_ms)
        register(opts, attempts - 1)

      other ->
        other
    end
  end

  @impl GenServer
  def init(opts) do
    Process.flag(:trap_exit, true)
    send(opts.observer, {:ready, opts.generation, self()})
    {:ok, opts}
  end

  # Abnormal exit reason — exactly what `{:client_exit, {:nick_rejected,
  # 433, _}}` is to the supervisor: a `:transient` restart trigger.
  @impl GenServer
  def handle_info(:crash, opts), do: {:stop, :boom, opts}

  # Hand the key to a live stranger BEFORE dying, so the stopper's first
  # lookup after the `:DOWN` cannot mistake the situation for cleanup lag.
  @impl GenServer
  def terminate(_reason, %{handoff: squatter} = opts) when is_pid(squatter) do
    Registry.unregister(Grappa.SessionRegistry, Server.registry_key(opts.subject, opts.network_id))
    send(squatter, {:grab, self()})

    receive do
      {:grabbed, ^squatter} -> :ok
    after
      @handshake_ms -> :ok
    end
  end

  def terminate(_reason, %{refiller: refiller} = opts) when is_pid(refiller) do
    send(refiller, {:refill, opts.generation + 1, self()})

    receive do
      {:refilling, _} -> :ok
    after
      @handshake_ms -> :ok
    end
  end

  def terminate(_reason, _opts), do: :ok
end

defmodule Grappa.SessionStopSessionTest.Squatter do
  @moduledoc """
  A supervised child that takes the session key over from a `Holder`
  that is dying — the stand-in for a restart that lands INSIDE
  `stop_session/2`'s unregister poll, which is the #653 plateau: the
  poll finds a LIVE pid on the key and, pre-#854, could not tell that
  from the Registry's cleanup lag on the corpse it had just buried.

  The hand-off is a handshake driven from the holder's `terminate/2`,
  not a race for the key: the holder unregisters itself, this process
  registers, and only then does the holder die. So the stopper's very
  first post-`:DOWN` lookup is GUARANTEED to see a live stranger on the
  key — the observation the plateau is made of — instead of it being a
  coin toss with the Registry's cleanup.
  """

  use GenServer, restart: :temporary

  alias Grappa.Session.Server

  def child_spec(opts) do
    %{
      id: {__MODULE__, opts.subject, opts.network_id},
      start: {__MODULE__, :start_link, [opts]},
      restart: :temporary
    }
  end

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @impl GenServer
  def init(opts), do: {:ok, opts}

  @impl GenServer
  def handle_info({:grab, from}, opts) do
    {:ok, _} =
      Registry.register(Grappa.SessionRegistry, Server.registry_key(opts.subject, opts.network_id), nil)

    send(from, {:grabbed, self()})
    send(opts.observer, {:squatted, self()})
    {:noreply, opts}
  end
end

defmodule Grappa.SessionStopSessionTest do
  @moduledoc """
  #854 — `stop_session/2` promises a POST-CONDITION ("no session is
  registered for this `(subject, network_id)`"), not an action ("I
  terminated the pid I happened to see").

  `Session.Server` is `restart: :transient`, so any abnormal exit —
  the 433 ladder ending in `{:client_exit, {:nick_rejected, 433, _}}`
  is the measured one — makes `Grappa.SessionSupervisor` restart the
  child, and the restarted child re-registers the SAME registry key
  inside its `GenServer.start_link/3`. A tear-down that reads the
  Registry alone cannot see that restart: it either finds the key
  momentarily free, or finds it refilled by a pid it never terminated.
  Either way the session survives its own stop.

  These tests use the real supervisor and the real `:transient` policy;
  only the child module is a stand-in.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Session
  alias Grappa.SessionStopSessionTest.Holder
  alias Grappa.SessionStopSessionTest.Squatter

  setup do
    subject = {:visitor, Ecto.UUID.generate()}
    network_id = System.unique_integer([:positive])

    on_exit(fn -> drain_key(subject, network_id, 20) end)

    %{subject: subject, network_id: network_id}
  end

  describe "stop_session/2 post-condition" do
    test "the key is free and the process dead for a session nobody restarts", ctx do
      {:ok, pid} = start_holder(ctx, generation: 0, register_delay_ms: 0, refiller: nil, handoff: nil)
      assert_receive {:ready, 0, ^pid}, 1_000

      log = capture_log(fn -> assert :ok = Session.stop_session(ctx.subject, ctx.network_id) end)

      refute Process.alive?(pid)
      assert Session.whereis(ctx.subject, ctx.network_id) == nil
      refute log =~ "post-condition"
    end

    # The measured #854 defect. The restart is IN FLIGHT when the stop
    # runs: the supervisor is blocked inside the restarted child's
    # `start_link/1`, so the Registry answers `nil` for a key that is
    # about to be refilled. Pre-fix `stop_session/2` returns `:ok` on
    # that `nil` (or burns its 500 ms poll against the refilled key) and
    # the restarted session outlives the tear-down that promised to
    # remove it.
    test "a :transient restart in flight does not survive stop_session/2", ctx do
      {:ok, gen0} = start_holder(ctx, generation: 0, register_delay_ms: 50, refiller: nil, handoff: nil)
      assert_receive {:starting, 0}, 1_000
      assert_receive {:ready, 0, ^gen0}, 1_000

      send(gen0, :crash)

      # Proves the supervisor is inside the restart, not that "enough
      # time has passed": `start_link/1` emits this from the
      # supervisor's own process before it registers the new child.
      assert_receive {:starting, 0}, 1_000

      assert :ok = Session.stop_session(ctx.subject, ctx.network_id)

      assert_receive {:ready, 0, restarted}, 1_000

      refute Process.alive?(restarted),
             "the :transient restart survived stop_session/2 — the session key is held by a " <>
               "live process the stop never terminated (#854)"

      assert Session.whereis(ctx.subject, ctx.network_id) == nil
    end

    # The backstop. When the key keeps being refilled faster than the
    # stop can free it, the failed post-condition MUST be loud —
    # CLAUDE.md "No silent-swallow at boundaries", and the sibling
    # `:DOWN`-timeout path 40 lines up already does exactly this.
    # Pre-fix this returns `:ok` after ~500 ms with no log line at all,
    # which is what let the defect live for months.
    test "an unwinnable refill chase logs an error instead of a silent :ok", ctx do
      refiller = start_refiller(ctx, max_generation: 4)

      {:ok, gen0} = start_holder(ctx, generation: 0, register_delay_ms: 0, refiller: refiller, handoff: nil)
      assert_receive {:ready, 0, ^gen0}, 1_000

      log = capture_log(fn -> assert :ok = Session.stop_session(ctx.subject, ctx.network_id) end)

      assert log =~ "[error]"
      assert log =~ "post-condition"
      assert log =~ inspect(ctx.subject)
    end

    # The #653 plateau, and the ONLY test that constrains the poll's
    # corpse-vs-refill discriminator: the squatter holds the key for the
    # whole stop, so a poll that cannot tell it from cleanup lag sleeps
    # out its entire budget (100 × 5 ms) before the chase can act.
    test "the unregister poll does not sleep out its budget against a refilled key", ctx do
      {:ok, squatter} =
        DynamicSupervisor.start_child(
          Grappa.SessionSupervisor,
          Squatter.child_spec(%{subject: ctx.subject, network_id: ctx.network_id, observer: self()})
        )

      {:ok, gen0} =
        start_holder(ctx, generation: 0, register_delay_ms: 0, refiller: nil, handoff: squatter)

      assert_receive {:ready, 0, ^gen0}, 1_000

      {elapsed_us, :ok} =
        :timer.tc(fn -> Session.stop_session(ctx.subject, ctx.network_id) end)

      assert_receive {:squatted, ^squatter}, 1_000

      refute Process.alive?(gen0)
      refute Process.alive?(squatter)
      assert Session.whereis(ctx.subject, ctx.network_id) == nil

      # Half an unregister budget. Measured ~5 ms once the poll stops
      # waiting on a live holder; ~505 ms when it cannot tell one from a
      # corpse — so the bound is not a timing guess, it sits 2× away from
      # both the behaviour it allows and the one it rules out.
      assert div(elapsed_us, 1_000) < 250,
             "stop_session burned #{div(elapsed_us, 1_000)}ms — the unregister poll cannot " <>
               "tell a Registry corpse from a key a restart refilled (#854/#653)"
    end
  end

  defp start_holder(ctx, opts) do
    DynamicSupervisor.start_child(Grappa.SessionSupervisor, Holder.child_spec(holder_opts(ctx, opts)))
  end

  defp holder_opts(ctx, opts) do
    %{
      subject: ctx.subject,
      network_id: ctx.network_id,
      observer: self(),
      generation: Keyword.fetch!(opts, :generation),
      register_delay_ms: Keyword.fetch!(opts, :register_delay_ms),
      refiller: Keyword.fetch!(opts, :refiller),
      handoff: Keyword.fetch!(opts, :handoff)
    }
  end

  defp start_refiller(ctx, max_generation: max) do
    test_pid = self()

    spawn_link(fn ->
      refill_loop(
        fn generation ->
          %{
            subject: ctx.subject,
            network_id: ctx.network_id,
            observer: test_pid,
            generation: generation,
            register_delay_ms: 0,
            refiller: self(),
            handoff: nil
          }
        end,
        max
      )
    end)
  end

  defp refill_loop(opts_fun, max) do
    receive do
      {:refill, generation, from} ->
        send(from, {:refilling, generation})

        if generation <= max do
          _ = DynamicSupervisor.start_child(Grappa.SessionSupervisor, Holder.child_spec(opts_fun.(generation)))
        end

        refill_loop(opts_fun, max)

      :stop ->
        refill_loop(opts_fun, -1)
    end
  end

  # The refill chain outlives a failed stop by design, so the singleton
  # supervisor must be left clean for the next test.
  defp drain_key(_subject, _network_id, 0), do: :ok

  defp drain_key(subject, network_id, attempts) do
    case Session.whereis(subject, network_id) do
      nil ->
        :ok

      pid ->
        _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
        drain_key(subject, network_id, attempts - 1)
    end
  end
end
