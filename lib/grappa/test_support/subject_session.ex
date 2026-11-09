if Mix.env() in [:dev, :test] do
  defmodule Grappa.TestSupport.SubjectSession do
    @moduledoc """
    Primitives shared by the test-only subject orchestrators: seeding a
    channel's synthetic scrollback, and bringing a credential's
    `Session.Server` up to a settled state (spawned, WELCOME received,
    every autojoin channel `:joined`).

    Compile-gated to `:dev` and `:test` Mix envs — the module literally
    does not exist in the prod release.

    Extracted from `Grappa.TestSupport.SubjectReset` so
    `Grappa.TestSupport.SubjectProvision` (#1078) can bring a
    brand-new subject up the same way the reset brings an existing one
    back up. The two verbs differ in what precedes the spawn (create vs
    drain), not in what "settled" means — sharing that definition is
    what keeps a provisioned subject and a reset subject the same shape.

    ## Why the waits are hard-bounded

    `start_and_settle/2` awaits `{:session_ready, ref}` (001
    RPL_WELCOME) via the existing `notify_pid` mechanism — the same
    primitive `Visitors.Login.preempt_and_respawn/4` uses — then polls
    `Session.get_window_state/3` until every autojoin channel reaches
    `:joined`. Both waits have a hard #{5_000}ms budget and fail loud;
    no silent retry loops.

    5s is intentionally tight for a test-only path. The e2e testnet runs
    Bahamut on local-loopback; a >5s WELCOME means upstream sickness or
    a `Session.Server` crash-loop, NOT transient network slowness.
    """

    use Boundary,
      top_level?: true,
      deps: [
        Grappa.IRC,
        Grappa.Networks,
        Grappa.Scrollback,
        Grappa.Session,
        Grappa.SpawnOrchestrator
      ]

    alias Grappa.{Networks, Scrollback, Session}

    @welcome_timeout_ms 5_000
    @autojoin_timeout_ms 5_000
    @autojoin_poll_interval_ms 50
    @default_seed_gap_ms 100

    @typedoc """
    Wall-clock of each span bringing a session up, in milliseconds. The
    caller folds these into whatever phase map it publishes.
    """
    @type settle_phases :: %{
            spawn_ms: non_neg_integer(),
            welcome_ms: non_neg_integer(),
            autojoin_ms: non_neg_integer()
          }

    @type settle_error ::
            {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}
            | {:autojoin_timeout, String.t(), [String.t()]}

    @doc """
    Times `fun` and returns `{elapsed_ms, result}`.
    """
    @spec measure((-> result)) :: {non_neg_integer(), result} when result: var
    def measure(fun) when is_function(fun, 0) do
      started_at = System.monotonic_time(:millisecond)
      result = fun.()
      {System.monotonic_time(:millisecond) - started_at, result}
    end

    @doc """
    Inserts `count` synthetic `:privmsg` rows from `sender` into
    `(user_id, network_id, channel)`, monotonically spaced
    #{@default_seed_gap_ms}ms apart and ending at "now".

    `:gap_ms` overrides the spacing (#2311). The default corpus is
    ~20s wide, which is what every scroll spec is calibrated against
    and what yields exactly ONE day separator; a spec about the day
    boundary needs a corpus that crosses midnight, and widening the
    gap is the whole of that change — the newest row still lands at
    "now", so nothing else about the seed moves.

    Does NOT truncate first — callers that need a truncate own that
    decision (`SubjectReset` truncates because the channel already
    holds a prior spec's rows; `SubjectProvision` does not because the
    subject was created a millisecond ago and cannot have any).
    """
    @spec seed_channel(
            Ecto.UUID.t(),
            integer(),
            String.t(),
            non_neg_integer(),
            String.t(),
            keyword()
          ) :: :ok
    def seed_channel(user_id, network_id, channel, count, sender, opts \\ [])
        when is_binary(user_id) and is_integer(network_id) and is_binary(channel) and
               is_integer(count) and count >= 0 and is_binary(sender) do
      gap_ms = Keyword.get(opts, :gap_ms, @default_seed_gap_ms)

      unless is_integer(gap_ms) and gap_ms > 0 do
        raise ArgumentError, "seed_channel/6: :gap_ms must be a positive integer, got #{inspect(gap_ms)}"
      end

      base_time = System.system_time(:millisecond) - count * gap_ms

      Enum.each(1..count//1, fn i ->
        {:ok, _} =
          Scrollback.persist_event(%{
            user_id: user_id,
            network_id: network_id,
            channel: channel,
            server_time: base_time + i * gap_ms,
            kind: :privmsg,
            sender: sender,
            body: "seed line ##{i}",
            meta: %{}
          })
      end)
    end

    @doc """
    Spawns the `Session.Server` for `(user, cred)` and returns once it
    has received RPL_WELCOME and every channel in the resolved session
    plan's autojoin list has reached `:joined`.

    Assumes no session is currently running for the pair — callers that
    might have one stop it first.

    Returns `{phases, outcome}`, phases FIRST and unconditionally: a
    failed attempt is exactly the one whose timings never reach the
    caller's return value, and #934 spent a whole investigation
    inferring a 433's existence from arithmetic. Spans not reached read
    zero.
    """
    @spec start_and_settle(Grappa.Accounts.User.t(), Networks.Credential.t()) ::
            {settle_phases(), :ok | {:error, settle_error()}}
    def start_and_settle(user, cred) do
      slug = cred.network.slug

      case Networks.SessionPlan.resolve(cred) do
        {:ok, plan} -> spawn_await_join(user, cred, slug, plan)
        {:error, reason} -> {zero_phases(), {:error, {:reconnect_failed, slug, reason}}}
      end
    end

    defp zero_phases, do: %{spawn_ms: 0, welcome_ms: 0, autojoin_ms: 0}

    defp spawn_await_join(user, cred, slug, plan) do
      ref = make_ref()
      plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})

      capacity_input = %{
        network_id: cred.network_id,
        # #171: this is a boot-shaped path — no conn, no IP.
        source_ip: nil,
        flow: :bootstrap_user,
        requesting_subject: nil
      }

      {spawn_ms, spawned} =
        measure(fn ->
          Grappa.SpawnOrchestrator.spawn(
            {:user, user.id},
            cred.network_id,
            plan_with_notify,
            capacity_input
          )
        end)

      case spawned do
        {:ok, _, pid} ->
          await_welcome_then_join(user, cred, slug, plan, ref, pid, spawn_ms)

        {:error, reason} ->
          {%{zero_phases() | spawn_ms: spawn_ms}, {:error, {:reconnect_failed, slug, reason}}}
      end
    end

    defp await_welcome_then_join(user, cred, slug, plan, ref, pid, spawn_ms) do
      {welcome_ms, ready} = measure(fn -> await_ready(pid, ref, slug) end)

      {autojoin_ms, outcome} =
        case ready do
          :ok ->
            autojoin = Map.get(plan, :autojoin_channels, [])
            measure(fn -> await_autojoin(user, cred, slug, autojoin) end)

          {:error, _} = err ->
            {0, err}
        end

      {%{spawn_ms: spawn_ms, welcome_ms: welcome_ms, autojoin_ms: autojoin_ms}, outcome}
    end

    defp await_ready(pid, ref, slug) do
      monitor_ref = Process.monitor(pid)

      receive do
        {:session_ready, ^ref} ->
          Process.demonitor(monitor_ref, [:flush])
          :ok

        {:DOWN, ^monitor_ref, :process, ^pid, reason} ->
          {:error, {:reconnect_failed, slug, reason}}
      after
        @welcome_timeout_ms ->
          Process.demonitor(monitor_ref, [:flush])
          {:error, {:reconnect_timeout, slug}}
      end
    end

    defp await_autojoin(_, _, _, []), do: :ok

    defp await_autojoin(user, cred, slug, autojoin) do
      deadline = System.monotonic_time(:millisecond) + @autojoin_timeout_ms

      pending =
        autojoin
        |> Enum.map(&Grappa.IRC.Identifier.canonical_target/1)
        |> MapSet.new()

      poll_autojoin({:user, user.id}, cred.network_id, slug, pending, deadline)
    end

    defp poll_autojoin(subject, network_id, slug, pending, deadline) do
      remaining =
        Enum.reduce(pending, pending, fn channel, acc ->
          case Session.get_window_state(subject, network_id, channel) do
            {:ok, %{state: :joined}} -> MapSet.delete(acc, channel)
            _ -> acc
          end
        end)

      cond do
        MapSet.size(remaining) == 0 ->
          :ok

        System.monotonic_time(:millisecond) >= deadline ->
          {:error, {:autojoin_timeout, slug, Enum.sort(MapSet.to_list(remaining))}}

        true ->
          Process.sleep(@autojoin_poll_interval_ms)
          poll_autojoin(subject, network_id, slug, remaining, deadline)
      end
    end
  end
end
