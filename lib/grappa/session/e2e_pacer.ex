defmodule Grappa.Session.E2EPacer do
  @moduledoc """
  Paces outbound E2E lines per recipient (issue 2430). Pure data;
  `Grappa.Session.Server` holds one in its state, sends what it releases
  and arms a timer for the next release.

  ## Why per recipient, and why 3 in 6 s

  bahamut — Azzurra, all of prod — compiles in `FLUD`
  (`bahamut/src/s_user.c` `check_for_flud/4`, `FLUD_NUM 4`, `FLUD_TIME 3`,
  `FLUD_BLOCK 15` in `include/config.h`). Every CTCP PRIVMSG reaching a
  local client is counted per sender: the sender's `count` keeps growing
  while its `first_msg` is no older than 3 s (integer `time()`), and its
  entry is only collected once its LAST message is older than 3 s. When
  the total over all senders exceeds 4, every CTCP to that client is
  blocked for 15 s, silently for the senders, and each further CTCP
  extends the block. An E2E line is a CTCP (`ACTION` and NOTICE are not
  counted). w2 measured this from source on 2430 and simulated pacers
  against a port of the function; w1 re-read it here.

  The consequence for a pacer: "3 in any 3 s" is NOT safe. A second burst
  at `first_msg + 3` still counts the whole first one (`first_msg < now -
  3` is false at the boundary), so it lands at 6 > 4; integer seconds and
  arrival jitter make it worse. w2's simulation: 3-per-3 s blocked 2588 of
  3000 trials, 3-per-6 s blocked none even at 2 s of jitter. So at most 3
  lines reach one recipient in any 6 s window: a burst of 3, then one
  line every 2 s, with one of bahamut's 4 slots left for whoever else is
  talking to them. The Python package (irc-olm) uses the same default.

  Known gap, not covered here: grappa's own lazy CTCP USERINFO/AVATAR
  probes on a peer's JOIN do not go through this pacer, so a probe landing
  during a burst can still take that spare slot.

  `Grappa.IRC.Client`'s fake-lag pacing does not cover this: it bounds
  OUR output towards the server as a whole ("Excess Flood"), not what one
  recipient receives.

  The key is the recipient's folded nick (the caller folds); lines keep
  the raw target they were queued with, which is what goes on the wire.

  ## Bounded

  At most 128 lines wait per recipient; past that `enqueue/5` refuses
  the whole message rather than accept part of it — a half-sent message
  is discarded by the receiver's reassembly anyway, so accepting it would
  only spend the window on lines nobody can use.
  """

  @window_ms 6_000
  @per_window 3
  @max_queued 128

  @typedoc "A line released for sending: the raw target and the PRIVMSG body."
  @type release :: {target :: String.t(), body :: binary()}

  @typep lane :: %{sent: [integer()], queue: :queue.queue(release())}

  @enforce_keys [:lanes]
  defstruct @enforce_keys

  @type t :: %__MODULE__{lanes: %{String.t() => lane()}}

  @doc "An idle pacer."
  @spec new() :: t()
  def new, do: %__MODULE__{lanes: %{}}

  @doc """
  Queues `bodies` for `target` (folded `key`) at monotonic `now_ms` and
  releases whatever the window allows right away.

  Returns the releases to send now and the delay in ms until the next
  release is due (`nil` when nothing is left waiting anywhere).
  `{:error, :queue_full}` leaves the pacer unchanged.
  """
  @spec enqueue(t(), String.t(), String.t(), [binary(), ...], integer()) ::
          {:ok, [release()], t(), non_neg_integer() | nil} | {:error, :queue_full}
  def enqueue(%__MODULE__{} = pacer, key, target, [_ | _] = bodies, now_ms) do
    lane = Map.get(pacer.lanes, key, %{sent: [], queue: :queue.new()})

    if :queue.len(lane.queue) + length(bodies) > @max_queued do
      {:error, :queue_full}
    else
      queue = Enum.reduce(bodies, lane.queue, &:queue.in({target, &1}, &2))
      pacer = %{pacer | lanes: Map.put(pacer.lanes, key, %{lane | queue: queue})}
      {releases, pacer, wait} = release(pacer, now_ms)
      {:ok, releases, pacer, wait}
    end
  end

  @doc """
  Releases every line whose window has opened at `now_ms`, across all
  recipients. Returns the releases, the pacer, and the delay until the
  next one (`nil` when the pacer is idle).
  """
  @spec release(t(), integer()) :: {[release()], t(), non_neg_integer() | nil}
  def release(%__MODULE__{} = pacer, now_ms) do
    {releases, lanes, waits} =
      Enum.reduce(pacer.lanes, {[], %{}, []}, fn {key, lane}, {releases, lanes, waits} ->
        {out, lane} = drain(lane, now_ms)

        case classify(lane, now_ms) do
          :drop -> {releases ++ out, lanes, waits}
          {:keep, nil} -> {releases ++ out, Map.put(lanes, key, lane), waits}
          {:keep, wait} -> {releases ++ out, Map.put(lanes, key, lane), [wait | waits]}
        end
      end)

    {releases, %{pacer | lanes: lanes}, if(waits == [], do: nil, else: Enum.min(waits))}
  end

  @spec drain(lane(), integer()) :: {[release()], lane()}
  defp drain(lane, now_ms) do
    sent = Enum.filter(lane.sent, &(now_ms - &1 < @window_ms))
    drain(%{lane | sent: sent}, now_ms, [])
  end

  @spec drain(lane(), integer(), [release()]) :: {[release()], lane()}
  defp drain(lane, now_ms, acc) do
    with true <- length(lane.sent) < @per_window,
         {{:value, release}, queue} <- :queue.out(lane.queue) do
      drain(%{lane | sent: [now_ms | lane.sent], queue: queue}, now_ms, [release | acc])
    else
      _ -> {Enum.reverse(acc), lane}
    end
  end

  # After a drain, `sent` holds only sends inside the window. A lane with
  # lines still queued is full (the drain stopped on the window), so its
  # next slot opens when its oldest send leaves the window. A lane with
  # nothing queued but recent sends must STAY, or a new message would get a
  # fresh window while the ircd still counts the old lines; it needs no
  # timer, the next enqueue re-reads it. Only a lane with neither goes.
  @spec classify(lane(), integer()) :: {:keep, pos_integer() | nil} | :drop
  defp classify(lane, now_ms) do
    cond do
      not :queue.is_empty(lane.queue) -> {:keep, Enum.min(lane.sent) + @window_ms - now_ms}
      lane.sent != [] -> {:keep, nil}
      true -> :drop
    end
  end
end
