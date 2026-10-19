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

  ## Which line goes next: urgent first, within a budget, peers in turn

  An URGENT message (KEYREQ, NACK, grappa's own KEYS, and an encrypted
  message the client marks as carrying a CHAL or ACK) goes ahead of the
  TEXT queued for the same peer. A CHAL expires 15 s after it is made:
  behind a 64-line message it would expire in this queue. Overtaking is
  safe for decryption up to a point: reassembly is per msgid, and vodozemac
  keeps 40 skipped message keys, so a message overtaken by more than 40
  later ones becomes undecryptable (w2 measured it: 45 queued, 5 lost).

  "Urgent always first" was the first rule (vjt's ruling on 2430, option
  A). w2's review of the same rule in irc-olm found that anyone holding a
  pinned nick could then starve text: a KEYREQ every 10 s draws a KEYS, a
  junk MSG every ~3 s draws a NACK. vjt approved the departure (2430,
  comment 6255346375), and the rule is now irc-olm's:

    * per peer, at most `urgent_budget/0` urgent lines RELEASED in any
      `urgent_window_ms/0`; past that, its urgent lines rank with text;
    * every peer whose FLUD window has a free slot offers ONE head line:
      its oldest urgent line if it has one, else its oldest text line;
    * heads are ranked by priority (0 = urgent within budget, 1 = text or
      urgent past budget), then by when that peer was last served (a peer
      never served, or quiet past its FLUD window, comes first), then by
      queue order. Text is therefore round-robin across peers, served
      longest-ago first, not one global FIFO;
    * within one peer, urgent before text, and each queue FIFO, so text is
      never reordered: the peer would display two messages backwards.

  The ranking is strict: when the best head does not fit the bank, nothing
  behind it overtakes, or a run of cheap lines could hold a full one back
  forever.

  The class is the caller's to give: grappa cannot see inside an encrypted
  message, so the client says which of its MSG/PKMSG lines are urgent
  (`priority: "control"`, see `Grappa.Session.send_e2e/6`).

  The lane key is the recipient's folded nick (the caller folds). Lines
  keep the raw target they were queued with, which is what goes on the
  wire.

  ## Bounded, and a refusal is always told

  Per peer, at most `max_text_messages/0` text MESSAGES wait (messages, not
  lines: each one is an Olm message, and an urgent one that overtakes more
  than 40 of them leaves the oldest undecryptable) and at most
  `max_urgent_lines/0` urgent lines. Across the connection at most
  `max_queued/0` lines wait, about ten minutes of drip: the bank
  serialises every peer anyway, so N peers times a per-peer line cap would
  be N times ten minutes of state.

  Past any bound `enqueue/7` refuses the WHOLE message with
  `{:error, :queue_full}`, which the send door answers 429: a half-sent
  message is discarded by the receiver's reassembly anyway, and the LOCAL
  sender is told, never silently dropped (vjt's ruling, 2430). Nothing goes
  to the peer.
  """

  alias Grappa.IRC.Client

  @window_ms 6_000
  @per_window 3
  @max_queued 128
  @max_text_messages 32
  @max_urgent_lines 32
  @urgent_budget 8
  @urgent_window_ms 60_000

  @typedoc "A line released for sending: the raw target and the PRIVMSG body."
  @type release :: {target :: String.t(), body :: binary()}

  @typedoc "A line to queue: the PRIVMSG body and what bahamut will charge for it, in ms."
  @type line :: {body :: binary(), cost_ms :: pos_integer()}

  @typedoc "Which queue a message joins: control goes ahead of text."
  @type class :: :control | :text

  # `seq` is the enqueue order across every lane: the last tie-break, and
  # the order within one queue. `last?` marks a message's final line, so
  # releasing it frees the message's place under `@max_text_messages`.
  @typep item ::
           {seq :: non_neg_integer(), target :: String.t(), body :: binary(), cost_ms :: pos_integer(),
            last? :: boolean()}

  # `sent`: this lane's releases inside the FLUD window. `urgent_sent`: its
  # urgent releases inside the urgent window. `text_messages`: text messages
  # with at least one line still queued.
  @typep lane :: %{
           sent: [integer()],
           urgent_sent: [integer()],
           control: :queue.queue(item()),
           text: :queue.queue(item()),
           text_messages: non_neg_integer()
         }

  @enforce_keys [:lanes, :seq]
  defstruct @enforce_keys

  @type t :: %__MODULE__{lanes: %{String.t() => lane()}, seq: non_neg_integer()}

  @doc "Lines that may wait on the whole connection."
  @spec max_queued() :: 128
  def max_queued, do: @max_queued

  @doc "Text messages that may wait for one peer."
  @spec max_text_messages() :: 32
  def max_text_messages, do: @max_text_messages

  @doc "Urgent lines that may wait for one peer."
  @spec max_urgent_lines() :: 32
  def max_urgent_lines, do: @max_urgent_lines

  @doc "Urgent lines one peer may be sent ahead of text in any `urgent_window_ms/0`."
  @spec urgent_budget() :: 8
  def urgent_budget, do: @urgent_budget

  @doc "The sliding window `urgent_budget/0` is counted over."
  @spec urgent_window_ms() :: 60_000
  def urgent_window_ms, do: @urgent_window_ms

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
  `{:error, :queue_full}` — past the connection's line cap, or this
  peer's text-message or urgent-line cap — leaves the pacer unchanged.
  """
  @spec enqueue(t(), String.t(), String.t(), class(), [line(), ...], integer(), non_neg_integer()) ::
          {:ok, [release()], t(), pos_integer() | nil} | {:error, :queue_full}
  def enqueue(%__MODULE__{} = pacer, key, target, class, [_ | _] = lines, now_ms, bank_ms)
      when class in [:control, :text] do
    lane =
      Map.get(pacer.lanes, key, %{
        sent: [],
        urgent_sent: [],
        control: :queue.new(),
        text: :queue.new(),
        text_messages: 0
      })

    if queued(pacer) + length(lines) > @max_queued or not room?(lane, class, lines) do
      {:error, :queue_full}
    else
      last = length(lines) - 1

      {items, seq} =
        lines
        |> Enum.with_index()
        |> Enum.map_reduce(pacer.seq, fn {{body, cost}, i}, n -> {{n, target, body, cost, i == last}, n + 1} end)

      lane = %{lane | class => Enum.reduce(items, Map.fetch!(lane, class), &:queue.in/2)}
      lane = if class == :text, do: %{lane | text_messages: lane.text_messages + 1}, else: lane
      queued = %{pacer | lanes: Map.put(pacer.lanes, key, lane), seq: seq}
      {releases, released, wait} = release(queued, now_ms, bank_ms)
      {:ok, releases, released, wait}
    end
  end

  @spec room?(lane(), class(), [line(), ...]) :: boolean()
  defp room?(lane, :text, _), do: lane.text_messages < @max_text_messages
  defp room?(lane, :control, lines), do: :queue.len(lane.control) + length(lines) <= @max_urgent_lines

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
        {key,
         %{
           lane
           | sent: Enum.filter(lane.sent, &(now_ms - &1 < @window_ms)),
             urgent_sent: Enum.filter(lane.urgent_sent, &(now_ms - &1 < @urgent_window_ms))
         }}
      end)

    {releases, drained, wait} = drain(pruned, now_ms, bank_ms, [])
    {releases, %{pacer | lanes: Map.reject(drained, fn {_, lane} -> idle?(lane) end)}, wait}
  end

  @spec drain(%{String.t() => lane()}, integer(), non_neg_integer(), [release()]) ::
          {[release()], %{String.t() => lane()}, pos_integer() | nil}
  defp drain(lanes, now_ms, bank_ms, acc) do
    case next(lanes) do
      nil ->
        {Enum.reverse(acc), lanes, lanes |> wakes(now_ms) |> Enum.min(fn -> nil end)}

      {key, queue, {_, target, body, cost, _} = item} ->
        if bank_ms == 0 or bank_ms + cost <= Client.fake_lag_ceiling_ms() do
          lane = lanes |> Map.fetch!(key) |> sent(queue, item, now_ms)
          drain(Map.put(lanes, key, lane), now_ms, bank_ms + cost, [{target, body} | acc])
        else
          # Room opens when the bank has drained by the excess, or when it
          # is empty, whichever comes first. Another line may be due sooner:
          # see `wakes/2`.
          bank_wait = min(bank_ms + cost - Client.fake_lag_ceiling_ms(), bank_ms)
          {Enum.reverse(acc), lanes, Enum.min([bank_wait | wakes(lanes, now_ms)])}
        end
    end
  end

  # Takes `item`, the head of `queue`, off the lane and records it as sent.
  @spec sent(lane(), class(), item(), integer()) :: lane()
  defp sent(lane, queue, {_, _, _, _, last?}, now_ms) do
    lane = %{lane | queue => :queue.drop(Map.fetch!(lane, queue)), sent: [now_ms | lane.sent]}

    case queue do
      :control -> %{lane | urgent_sent: [now_ms | lane.urgent_sent]}
      :text when last? -> %{lane | text_messages: lane.text_messages - 1}
      :text -> lane
    end
  end

  # The next line to consider: the best-ranked head among the peers with a
  # free FLUD slot (see the moduledoc).
  @spec next(%{String.t() => lane()}) :: {String.t(), class(), item()} | nil
  defp next(lanes) do
    heads = lanes |> Enum.filter(fn {_, lane} -> length(lane.sent) < @per_window end) |> Enum.flat_map(&head/1)
    if heads == [], do: nil, else: heads |> Enum.min_by(&elem(&1, 0)) |> elem(1)
  end

  # One peer's head line and its rank: `{priority, last served, seq}`. A
  # peer with no release left in its FLUD window ranks as never served:
  # `{0, 0}` sorts before every `{1, at}`, whatever the monotonic clock's
  # sign.
  @spec head({String.t(), lane()}) :: [{tuple(), {String.t(), class(), item()}}]
  defp head({key, lane}) do
    served = if lane.sent == [], do: {0, 0}, else: {1, Enum.max(lane.sent)}

    case {:queue.peek(lane.control), :queue.peek(lane.text)} do
      {{:value, item}, _} ->
        priority = if length(lane.urgent_sent) < @urgent_budget, do: 0, else: 1
        [{{priority, served, elem(item, 0)}, {key, :control, item}}]

      {:empty, {:value, item}} ->
        [{{1, served, elem(item, 0)}, {key, :text, item}}]

      {:empty, :empty} ->
        []
    end
  end

  # Every delay, short of bank room, after which the next release could
  # differ, over the lanes with lines waiting. Waking early costs one call
  # that releases nothing; waking late holds a line that could have gone.
  @spec wakes(%{String.t() => lane()}, integer()) :: [pos_integer()]
  defp wakes(lanes, now_ms) do
    lanes
    |> Map.values()
    |> Enum.reject(&waiting_empty?/1)
    |> Enum.flat_map(&changes/1)
    |> Enum.map(&(&1 - now_ms))
  end

  # A full FLUD window gets a slot back when its oldest send leaves it. An
  # open one offers a head whose rank changes with time alone: when the
  # peer's last send leaves the window it ranks as never served, and when
  # its `urgent_budget/0`-th newest urgent release leaves the urgent window
  # its urgent head is urgent again.
  @spec changes(lane()) :: [integer()]
  defp changes(%{sent: sent}) when length(sent) >= @per_window, do: [Enum.min(sent) + @window_ms]

  defp changes(lane) do
    served = if lane.sent == [], do: [], else: [Enum.max(lane.sent) + @window_ms]

    if :queue.is_empty(lane.control) or length(lane.urgent_sent) < @urgent_budget,
      do: served,
      else: [Enum.at(Enum.sort(lane.urgent_sent, :desc), @urgent_budget - 1) + @urgent_window_ms | served]
  end

  @spec queued(t()) :: non_neg_integer()
  defp queued(pacer),
    do: Enum.reduce(pacer.lanes, 0, fn {_, lane}, n -> n + :queue.len(lane.control) + :queue.len(lane.text) end)

  @spec waiting_empty?(lane()) :: boolean()
  defp waiting_empty?(lane), do: :queue.is_empty(lane.control) and :queue.is_empty(lane.text)

  # A lane with nothing waiting but recent sends must STAY, or a new
  # message would get a fresh window while the ircd still counts the old
  # lines, or a fresh urgent budget while the old one is still spent. Only
  # a lane with none of these goes.
  @spec idle?(lane()) :: boolean()
  defp idle?(lane), do: lane.sent == [] and lane.urgent_sent == [] and waiting_empty?(lane)
end
