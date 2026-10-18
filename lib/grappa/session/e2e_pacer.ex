defmodule Grappa.Session.E2ePacer do
  @moduledoc """
  Paces outbound E2E lines (issue 2430). Pure data: `Grappa.Session.Server`
  holds one in its state, reads the connection's fake-lag bank from
  `Grappa.IRC.Client` before every release, sends what is released and arms
  a timer for the next one.

  Every line obeys two rules, both read from bahamut's source, plus an
  order.

  ## Per recipient: at most 3 lines in any 6 s (FLUD)

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
  lines reach one recipient in any 6 s window. On its own that rule allows
  a burst of 3, then the next 3 once the oldest of them is 6 s old. One of
  bahamut's 4 slots stays free for whoever else is talking to them. The Python package (irc-olm) uses the same default.

  Known gap, not covered here: grappa's own lazy CTCP USERINFO/AVATAR
  probes on a peer's JOIN do not go through this pacer, so a probe landing
  during a burst can still take that spare slot.

  ## Per connection: never past the fake-lag ceiling

  bahamut charges every PRIVMSG `2 + len/120` s of fake lag
  (`src/parse.c:236`). It parses a client's recvQ only while that bank is
  under 10 s (`src/s_bsd.c:1657`), but it keeps reading the socket, and a
  non-oper whose unparsed recvQ passes 2560 bytes is disconnected for
  "Excess Flood" (`src/s_bsd.c:1795`). A full E2E line costs 5 s, so the
  FLUD rule alone still gets the connection killed around the 14th full
  line to one recipient (w1 and w2 each derived it from the source; 2430).

  vjt's ruling on 2430 (option A): a line is released only when the bank
  plus the line's own cost stays at or under the ceiling
  (`Grappa.IRC.Client.fake_lag_ceiling_ms/0`). No E2E line then ever waits
  unparsed in the ircd's recvQ. The bank comes from `Grappa.IRC.FakeLag`
  through `Client.fake_lag_bank_ms/1`, which records EVERY frame on the
  connection: registration, PONGs, the user's own messages. So E2E backs
  off while the user is talking, never the other way round. After the
  first two full lines a long message drips at one line per 5 s. A 64-line
  message takes about five minutes; slow delivery is accepted by the
  ruling, and receivers count their 60 s window from the LAST fragment.

  A line costlier than the ceiling on its own (possible only where LINELEN
  is far over 512) goes out once the bank is empty: bahamut parses any line
  that arrives under the gate, and holding it for room that can never open
  would hold it forever.

  ## Control messages first, text in order

  A CONTROL message (KEYREQ, NACK, grappa's own KEYS, and an encrypted
  message the client marks as carrying a CHAL or ACK) goes ahead of every
  queued TEXT line, to any recipient. A CHAL expires 15 s after it is made:
  behind a 64-line message it would expire in this queue. Overtaking is
  safe for decryption: reassembly is per msgid, and w2 measured vodozemac
  decrypting a message overtaken by up to 40 later ones (2430).

  Text is never reordered: a short text message waits behind a long one
  queued before it, or the peer would display the two backwards. Within a
  class, lines leave in the order they were queued. The class is the
  caller's to give: grappa cannot see inside an encrypted message, so the
  client says which of its MSG/PKMSG lines are control (see
  `Grappa.Session.send_e2e/6`).

  The lane key is the recipient's folded nick (the caller folds). Lines
  keep the raw target they were queued with, which is what goes on the
  wire.

  ## Bounded

  At most 128 lines wait on the whole connection, about ten minutes of
  drip. The cap is per CONNECTION, not per recipient, because the bank
  serialises every recipient anyway: N recipients times a per-recipient cap
  would be N times ten minutes of state. Past the cap `enqueue/7` refuses
  the whole message rather than accept part of it: a half-sent message is
  discarded by the receiver's reassembly anyway, so accepting it would only
  spend the window on lines nobody can use.
  """

  alias Grappa.IRC.Client

  @window_ms 6_000
  @per_window 3
  @max_queued 128

  @typedoc "A line released for sending: the raw target and the PRIVMSG body."
  @type release :: {target :: String.t(), body :: binary()}

  @typedoc "A line to queue: the PRIVMSG body and what bahamut will charge for it, in ms."
  @type line :: {body :: binary(), cost_ms :: pos_integer()}

  @typedoc "Which queue a message joins: control goes ahead of text."
  @type class :: :control | :text

  # `seq` is the enqueue order across every lane, so "the order they were
  # queued" holds across recipients as well as within one.
  @typep item :: {seq :: non_neg_integer(), target :: String.t(), body :: binary(), cost_ms :: pos_integer()}
  @typep lane :: %{sent: [integer()], control: :queue.queue(item()), text: :queue.queue(item())}

  @enforce_keys [:lanes, :seq]
  defstruct @enforce_keys

  @type t :: %__MODULE__{lanes: %{String.t() => lane()}, seq: non_neg_integer()}

  @doc "An idle pacer."
  @spec new() :: t()
  # Same call as `Grappa.IRC.FakeLag.new/0`: the success typing is the
  # empty singleton, and the result is stored in a field typed `t()`.
  @dialyzer {:nowarn_function, new: 0}
  def new, do: %__MODULE__{lanes: %{}, seq: 0}

  @doc """
  Queues the `lines` of one message of `class` for `target` (folded `key`)
  at monotonic `now_ms`, with the connection's current fake-lag bank
  `bank_ms`, and releases whatever both rules allow right away.

  Returns the releases to send now and the delay in ms until the next
  release could be due (`nil` when nothing is left waiting anywhere).
  `{:error, :queue_full}` leaves the pacer unchanged.
  """
  @spec enqueue(t(), String.t(), String.t(), class(), [line(), ...], integer(), non_neg_integer()) ::
          {:ok, [release()], t(), pos_integer() | nil} | {:error, :queue_full}
  def enqueue(%__MODULE__{} = pacer, key, target, class, [_ | _] = lines, now_ms, bank_ms)
      when class in [:control, :text] do
    lane = Map.get(pacer.lanes, key, %{sent: [], control: :queue.new(), text: :queue.new()})

    if queued(pacer) + length(lines) > @max_queued do
      {:error, :queue_full}
    else
      {items, seq} = Enum.map_reduce(lines, pacer.seq, fn {body, cost}, n -> {{n, target, body, cost}, n + 1} end)
      lane = %{lane | class => Enum.reduce(items, Map.fetch!(lane, class), &:queue.in/2)}
      queued = %{pacer | lanes: Map.put(pacer.lanes, key, lane), seq: seq}
      {releases, released, wait} = release(queued, now_ms, bank_ms)
      {:ok, releases, released, wait}
    end
  end

  @doc """
  Releases every line both rules allow at `now_ms`, given the connection's
  fake-lag bank `bank_ms` at that moment. Each release is charged to the
  bank before the next is considered, as `Grappa.IRC.FakeLag` will charge
  it once it is written.

  Returns the releases, the pacer, and the delay until the next release
  could be due (`nil` when the pacer is idle). The caller re-reads the
  bank when that delay is up: other traffic may have spent the room.
  """
  @spec release(t(), integer(), non_neg_integer()) :: {[release()], t(), pos_integer() | nil}
  def release(%__MODULE__{} = pacer, now_ms, bank_ms) do
    pruned =
      Map.new(pacer.lanes, fn {key, lane} ->
        {key, %{lane | sent: Enum.filter(lane.sent, &(now_ms - &1 < @window_ms))}}
      end)

    {releases, drained, wait} = drain(pruned, now_ms, bank_ms, [])
    {releases, %{pacer | lanes: Map.reject(drained, fn {_, lane} -> idle?(lane) end)}, wait}
  end

  @spec drain(%{String.t() => lane()}, integer(), non_neg_integer(), [release()]) ::
          {[release()], %{String.t() => lane()}, pos_integer() | nil}
  defp drain(lanes, now_ms, bank_ms, acc) do
    case next(lanes) do
      nil ->
        {Enum.reverse(acc), lanes, flud_wait(lanes, now_ms)}

      {key, queue, {_, target, body, cost}} ->
        if bank_ms == 0 or bank_ms + cost <= Client.fake_lag_ceiling_ms() do
          lane = Map.fetch!(lanes, key)
          lane = %{lane | queue => :queue.drop(Map.fetch!(lane, queue)), sent: [now_ms | lane.sent]}
          drain(Map.put(lanes, key, lane), now_ms, bank_ms + cost, [{target, body} | acc])
        else
          # Room opens when the bank has drained by the excess, or when it
          # is empty, whichever comes first. A recipient whose FLUD window
          # reopens sooner may hold an older line that fits by then.
          bank_wait = min(bank_ms + cost - Client.fake_lag_ceiling_ms(), bank_ms)
          {Enum.reverse(acc), lanes, min(bank_wait, flud_wait(lanes, now_ms) || bank_wait)}
        end
    end
  end

  # The next line to consider among recipients with a free FLUD slot: the
  # oldest control line, else the oldest text line.
  @spec next(%{String.t() => lane()}) :: {String.t(), class(), item()} | nil
  defp next(lanes) do
    open = Enum.filter(lanes, fn {_, lane} -> length(lane.sent) < @per_window end)
    oldest(open, :control) || oldest(open, :text)
  end

  @spec oldest([{String.t(), lane()}], class()) :: {String.t(), class(), item()} | nil
  defp oldest(lanes, queue) do
    lanes
    |> Enum.flat_map(fn {key, lane} ->
      case :queue.peek(Map.fetch!(lane, queue)) do
        {:value, item} -> [{key, queue, item}]
        :empty -> []
      end
    end)
    |> Enum.min_by(fn {_, _, {seq, _, _, _}} -> seq end, fn -> nil end)
  end

  # When the next FLUD slot opens on a recipient that has lines waiting but
  # a full window: when its oldest send leaves the window.
  @spec flud_wait(%{String.t() => lane()}, integer()) :: pos_integer() | nil
  defp flud_wait(lanes, now_ms) do
    lanes
    |> Map.values()
    |> Enum.filter(&(length(&1.sent) >= @per_window and not waiting_empty?(&1)))
    |> Enum.map(&(Enum.min(&1.sent) + @window_ms - now_ms))
    |> Enum.min(fn -> nil end)
  end

  @spec queued(t()) :: non_neg_integer()
  defp queued(pacer),
    do: Enum.reduce(pacer.lanes, 0, fn {_, lane}, n -> n + :queue.len(lane.control) + :queue.len(lane.text) end)

  @spec waiting_empty?(lane()) :: boolean()
  defp waiting_empty?(lane), do: :queue.is_empty(lane.control) and :queue.is_empty(lane.text)

  # A lane with nothing waiting but recent sends must STAY, or a new
  # message would get a fresh window while the ircd still counts the old
  # lines. Only a lane with neither goes.
  @spec idle?(lane()) :: boolean()
  defp idle?(lane), do: lane.sent == [] and waiting_empty?(lane)
end
