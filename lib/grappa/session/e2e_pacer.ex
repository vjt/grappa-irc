defmodule Grappa.Session.E2ePacer do
  @moduledoc """
  Paces outbound E2E lines (issue 2430). Pure data: `Grappa.Session.Server`
  holds one in its state, reads the connection's fake-lag bank from
  `Grappa.IRC.Client` before every release, sends what is released and arms
  a timer for the next one.

  The rule is irc-olm's final one (vjt, 2430 comment 6266838337, "it
  supersedes every earlier version"), and the reference implementation is
  irc-olm's `src/irc_olm/pacing.py` at 77688e5: this module follows its
  `Pacer` function by function (`_rank`, `_budget_rank`, `_allowed`,
  `_ahead`, `_order_before`, `_next`, `_limit`, `_drop_at`,
  `next_wakeup`), in integer milliseconds on the monotonic clock instead of
  float seconds. The two answer alike on the same inputs.

  ## Per recipient: at most 3 lines in any 6 s (FLUD)

  bahamut — Azzurra, all of prod — compiles in `FLUD`
  (`bahamut/src/s_user.c` `check_for_flud/4`, `FLUD_NUM 4`, `FLUD_TIME 3`,
  `FLUD_BLOCK 15` in `include/config.h`). Every CTCP PRIVMSG reaching a
  local client is counted per sender: the sender's `count` keeps growing
  while its `first_msg` is no older than 3 s (integer `time()`), and its
  entry is only collected once its LAST message is older than 3 s. When
  the total over all senders exceeds 4, every CTCP to that client is
  blocked for 15 s, silently for the senders, and each further CTCP
  extends the block. An E2E line is a CTCP.

  So "3 in any 3 s" is NOT safe: a second burst at `first_msg + 3` still
  counts the whole first one, and integer seconds and arrival jitter make
  it worse (w2's simulation: 3-per-3 s blocked 2588 of 3000 trials,
  3-per-6 s none even at 2 s of jitter). At most 3 lines reach one
  recipient in any 6 s; one of bahamut's 4 slots stays free for whoever
  else is talking to them.

  Known gap: grappa's own lazy CTCP USERINFO/AVATAR probes on a peer's
  JOIN do not go through this pacer, so a probe landing during a burst can
  still take that spare slot.

  ## Per connection: never past the fake-lag ceiling

  bahamut charges every PRIVMSG `2 + len/120` s of fake lag
  (`src/parse.c:236`). It parses a client's recvQ only while that bank is
  under 10 s (`src/s_bsd.c:1657`), and a non-oper whose unparsed recvQ
  passes 2560 bytes is disconnected for "Excess Flood"
  (`src/s_bsd.c:1795`). vjt's ruling (option A): a line is released only
  when the bank plus its own cost stays at or under its limit, so no E2E
  line ever waits unparsed in the recvQ. The bank comes from
  `Grappa.IRC.FakeLag` through `Client.fake_lag_bank_ms/1`, which records
  EVERY frame on the connection, so E2E backs off while the user is
  talking. A line dearer than its limit goes only at an empty bank. Slow
  long messages are accepted: receivers count their 60 s from the LAST
  fragment.

  ## Three lanes, scheduled by message

  * URGENT: KEYREQ, and a MSG/PKMSG the client marks `priority: "control"`
    because it carries a CHAL or an ACK (grappa cannot see inside it).
  * REACTIVE: what a peer draws from us, by outer verb: KEYS (grappa's own
    answer to a KEYREQ) and NACK.
  * TEXT: every other MSG/PKMSG.

  `lane/2` is the one mapping. Once an urgent or a text message's first
  line has left, no other message of its lane starts until it ends: one
  urgent and one text message are under way at a time, connection-wide.
  KEYS and NACKs are FIFO per target and may interleave across targets.
  Within a target each lane keeps its order, so a short message never
  overtakes a long one sent before it.

  URGENT and REACTIVE go ahead of text only within budgets of bank spent in
  `budget_window_ms/0`, counted on all of a message's lines when its first
  is due: URGENT `urgent_budget_ms/0` for the whole connection, whoever
  gives the orders; REACTIVE `reactive_budget_ms/0` per target and
  `reactive_total_ms/0` for the connection. Past its budget a message
  waits behind text, and still goes when no text line can (the bank would
  idle otherwise). A target that drew nothing else from a lane in the
  window may take the connection `fresh_allowance_ms/0` further, one
  message for all such targets together: an honest peer behind a flooder,
  a second human behind a chatty one. Its KEYS or NACK goes ahead of the
  others' not yet started, and its KEYS, once it has waited
  `fresh_patience_ms/0`, goes ahead of the orders queued after that
  instant too, paid once from URGENT's allowance.

  TEXT has no budget and a floor instead: with text queued and no text
  line released for `text_floor_ms/0`, a text message under way goes next
  after an order under way, so it reaches its receiver before the
  receiver's 60 s run out; one not started goes after the orders. A KEYS
  or NACK under way has the same floor from its own last line. Turns go
  to the target served longest ago. REACTIVE and TEXT lines never take the
  bank past the ceiling less `reserve_ms/0`, kept for URGENT ones, except
  a KEYS or NACK past its floor or a first contact's KEYS ahead of every
  order. When the best-ranked line does not fit the bank, nothing behind
  it overtakes.

  ## The CHAL deadline

  An urgent message may carry a deadline (the send door's `expires_at`):
  it starts only if its last line can leave `ack_margin_ms/0` before it,
  at the bank as it stands, so its answer can still come back. One that
  can no longer start in time is dropped unsent and reported in
  `release/3`'s `lost` (the session tells the sender); one that cannot
  even at `enqueue/7` is refused there with `:too_late`. A started message
  is never cut.

  ## Bounded, and a refusal is always told

  Per target, at most `max_text_messages/0` text messages wait, counting
  the Olm messages (MSG, PKMSG) refused or dropped behind queued text: the
  receiver skips a message key for each, and vodozemac keeps 40. At most
  `max_lane_lines/0` lines per target wait in each of URGENT and REACTIVE,
  at most `max_backlog_ms/0` of text bank on the whole connection, and at
  most `max_queued/0` urgent and reactive lines on the connection, so that
  what a session holds is bounded however many nicks draw from it. Text
  does not count against `max_queued/0`: its backlog already bounds it, and
  the user's own text must never leave an order unanswerable. Past any bound
  `enqueue/7` refuses the WHOLE message with `{:error, :queue_full, _}`,
  which the send door answers 429 (vjt's ruling: refuse and tell the local
  sender, never drop silently). Nothing goes to the peer.

  The key is the recipient's folded nick (the caller folds). Lines keep the
  raw target they were queued with, which is what goes on the wire.
  """

  alias Grappa.IRC.{Client, E2e}

  @window_ms 6_000
  @per_window 3
  @max_queued 128
  @max_backlog_ms 480_000
  @max_text_messages 32
  @max_lane_lines 32
  @reserve_ms 5_000
  @urgent_budget_ms 36_000
  @reactive_budget_ms 18_000
  @reactive_total_ms 22_000
  @fresh_allowance_ms 9_000
  @budget_window_ms 60_000
  @fresh_patience_ms 8_000
  @text_floor_ms 20_000
  @ack_margin_ms 2_000

  # Ranks, the lowest goes first; then turns (the target served longest
  # ago), then the order of submission. The reference's `_STARTED_URGENT`
  # … `_PAST_BUDGET`, which are the rule's ranks 1-11.
  @started_urgent 0
  @starved_started 1
  @fresh_first 2
  @urgent 3
  @fresh_next 4
  @starved_text 5
  @started_reactive 6
  @fresh_reactive 7
  @reactive 8
  @text 9
  @past_budget 10

  @lanes [:urgent, :reactive, :text]

  @typedoc "Where a message waits: see the moduledoc."
  @type lane :: :urgent | :reactive | :text

  @typedoc "What the client says of a MSG/PKMSG: `:control` when it carries a CHAL or an ACK."
  @type priority :: :control | :text

  @typedoc "A line to queue: the PRIVMSG body and what bahamut will charge for it, in ms."
  @type line :: {body :: binary(), cost_ms :: pos_integer()}

  @typedoc """
  The message the lines belong to: its msgid, outer verb and lane, and for
  an urgent one the monotonic instant its answer must be back by (or `nil`).
  """
  @type message :: %{msgid: String.t(), verb: E2e.verb(), lane: lane(), deadline_ms: integer() | nil}

  @typedoc "A line released for sending: the raw target, its message, and the PRIVMSG body."
  @type release :: {target :: String.t(), msgid :: String.t(), verb :: E2e.verb(), body :: binary()}

  @typedoc "A message dropped unsent, too late to be answered."
  @type lost :: {target :: String.t(), msgid :: String.t(), verb :: E2e.verb()}

  # `seq` is the submission order across every lane: the last tie-break.
  # `last?` marks a message's final line.
  @typep item :: %{
           seq: non_neg_integer(),
           target: String.t(),
           body: binary(),
           msgid: String.t(),
           verb: E2e.verb(),
           last?: boolean(),
           deadline: integer() | nil,
           cost: pos_integer()
         }

  @typep lanes :: %{urgent: [item()], reactive: [item()], text: [item()]}

  # A budget window: a target's lane, the connection's (`:connection`), or
  # what fresh KEYS paid to go ahead of the orders (`:paid`, URGENT only).
  @typep budget_key :: {String.t() | :connection | :paid, :urgent | :reactive}

  # The bank a line may fill: the fake-lag ceiling, or the ceiling less the
  # reserve left to URGENT.
  @typep limit :: 5_000 | 10_000

  # `queues`: folded target => its lanes, kept while any line waits.
  # `text_cost`: bank the queued text will cost. `text_messages` / `gap`:
  # per target, text messages queued and Olm messages refused or dropped
  # behind them. `sent`: per target, releases inside the FLUD window, newest
  # first. `served`: per target, its last release, for turns. `spent`:
  # budget windows, `{at, cost}` newest first. `open`: `{target, lane}` =>
  # the msgid of the message under way. `text_at`: the floor's clock, the
  # last text line. `reactive_at`: per target, since when REACTIVE has been
  # queued (the patience's clock). `cutoff`: per target, a seq drawn when
  # that patience ran out. `fresh` / `paid`: targets whose KEYS under way
  # started fresh / paid for going ahead.
  @enforce_keys [
    :queues,
    :seq,
    :text_cost,
    :text_messages,
    :gap,
    :sent,
    :served,
    :spent,
    :open,
    :text_at,
    :reactive_at,
    :cutoff,
    :fresh,
    :paid
  ]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          queues: %{String.t() => lanes()},
          seq: non_neg_integer(),
          text_cost: non_neg_integer(),
          text_messages: %{String.t() => non_neg_integer()},
          gap: %{String.t() => pos_integer()},
          sent: %{String.t() => [integer()]},
          served: %{String.t() => integer()},
          spent: %{budget_key() => [{integer(), pos_integer()}]},
          open: %{{String.t(), lane()} => String.t()},
          text_at: integer() | nil,
          reactive_at: %{String.t() => integer()},
          cutoff: %{String.t() => non_neg_integer()},
          fresh: MapSet.t(String.t()),
          paid: MapSet.t(String.t())
        }

  @doc "Urgent and reactive lines that may wait on the whole connection."
  @spec max_queued() :: 128
  def max_queued, do: @max_queued

  @doc "Bank the queued text of the whole connection may cost."
  @spec max_backlog_ms() :: 480_000
  def max_backlog_ms, do: @max_backlog_ms

  @doc "Text messages that may wait for one target, refused Olm messages behind them counted."
  @spec max_text_messages() :: 32
  def max_text_messages, do: @max_text_messages

  @doc "Lines that may wait for one target in each of the URGENT and REACTIVE lanes."
  @spec max_lane_lines() :: 32
  def max_lane_lines, do: @max_lane_lines

  @doc "Bank REACTIVE and TEXT lines leave free for URGENT ones."
  @spec reserve_ms() :: 5_000
  def reserve_ms, do: @reserve_ms

  @doc "Bank URGENT messages may spend ahead of text in any `budget_window_ms/0`, the whole connection."
  @spec urgent_budget_ms() :: 36_000
  def urgent_budget_ms, do: @urgent_budget_ms

  @doc "Bank one target's REACTIVE messages may spend ahead of text in any `budget_window_ms/0`."
  @spec reactive_budget_ms() :: 18_000
  def reactive_budget_ms, do: @reactive_budget_ms

  @doc "Bank all REACTIVE messages may spend ahead of text in any `budget_window_ms/0`."
  @spec reactive_total_ms() :: 22_000
  def reactive_total_ms, do: @reactive_total_ms

  @doc "How far past the connection's budget a target that drew nothing else may go."
  @spec fresh_allowance_ms() :: 9_000
  def fresh_allowance_ms, do: @fresh_allowance_ms

  @doc "The sliding window every budget is counted over."
  @spec budget_window_ms() :: 60_000
  def budget_window_ms, do: @budget_window_ms

  @doc "How long a first contact's KEYS waits before it goes ahead of the orders queued since."
  @spec fresh_patience_ms() :: 8_000
  def fresh_patience_ms, do: @fresh_patience_ms

  @doc "Text queued and no text line for this long: text goes next."
  @spec text_floor_ms() :: 20_000
  def text_floor_ms, do: @text_floor_ms

  @doc "How long before its deadline an urgent message's last line must leave."
  @spec ack_margin_ms() :: 2_000
  def ack_margin_ms, do: @ack_margin_ms

  @doc """
  The lane for a message of `verb` with the client's `priority`: KEYS and
  NACK are REACTIVE and KEYREQ URGENT whatever it says; a MSG/PKMSG is
  URGENT when `:control`, TEXT when `:text`.
  """
  @spec lane(E2e.verb(), priority()) :: lane()
  def lane(verb, priority) when verb in [:keys, :nack] and priority in [:control, :text], do: :reactive
  def lane(:keyreq, priority) when priority in [:control, :text], do: :urgent
  def lane(verb, :control) when verb in [:pkmsg, :msg], do: :urgent
  def lane(verb, :text) when verb in [:pkmsg, :msg], do: :text

  @doc "An idle pacer."
  @spec new() :: t()
  # Same call as `Grappa.IRC.FakeLag.new/0`: the success typing is the
  # empty singleton, and the result is stored in a field typed `t()`.
  @dialyzer {:nowarn_function, new: 0}
  def new do
    %__MODULE__{
      queues: %{},
      seq: 0,
      text_cost: 0,
      text_messages: %{},
      gap: %{},
      sent: %{},
      served: %{},
      spent: %{},
      open: %{},
      text_at: nil,
      reactive_at: %{},
      cutoff: %{},
      fresh: MapSet.new(),
      paid: MapSet.new()
    }
  end

  @doc """
  Queues the `lines` of `message` for `target` (folded `key`) at monotonic
  `now_ms`, with the connection's current fake-lag bank `bank_ms`, and
  releases whatever the rules allow right away.

  Returns the releases to send now, the messages dropped as too late, and
  the delay in ms until the next release could be due (`nil` when nothing
  waits). All or nothing: `{:error, :queue_full, pacer}` past any bound in
  the moduledoc, `{:error, :too_late, pacer}` for a message whose deadline
  its last line could no longer leave `ack_margin_ms/0` before. The pacer a
  refusal returns counts a refused MSG/PKMSG as a gap behind queued text;
  keep it.

  A deadline belongs to an urgent message only.
  """
  @spec enqueue(t(), String.t(), String.t(), message(), [line(), ...], integer(), non_neg_integer()) ::
          {:ok, [release()], [lost()], t(), pos_integer() | nil} | {:error, :queue_full | :too_late, t()}
  def enqueue(
        %__MODULE__{} = pacer,
        key,
        target,
        %{lane: lane, deadline_ms: deadline} = message,
        [_ | _] = lines,
        now_ms,
        bank_ms
      )
      when lane in @lanes and (is_nil(deadline) or (lane == :urgent and is_integer(deadline))) do
    {items, seq} = items(message, target, lines, pacer.seq)
    pacer = %{pacer | seq: seq}
    cost = Enum.sum(Enum.map(items, & &1.cost))
    olm = if olm?(message.verb), do: 1, else: 0

    cond do
      not admits?(pacer, key, lane, items, cost) ->
        {:error, :queue_full, left_a_gap(pacer, key, olm)}

      deadline != nil and now_ms >= drop_at(cost, deadline, now_ms, bank_ms) ->
        {:error, :too_late, left_a_gap(pacer, key, olm)}

      true ->
        {releases, lost, pacer, wait} = pacer |> queue(key, lane, items, cost) |> release(now_ms, bank_ms)
        {:ok, releases, lost, pacer, wait}
    end
  end

  @doc """
  Releases every line the rules allow at `now_ms`, given the connection's
  fake-lag bank `bank_ms` at that moment. Each release is charged to the
  bank before the next is considered, as `Grappa.IRC.FakeLag` will charge
  it once it is written.

  Returns the releases, the urgent messages dropped unsent because their
  answer could no longer make the deadline, the pacer, and the delay until
  the next release could be due (`nil` when the pacer is idle). The caller
  re-reads the bank when that delay is up: other traffic may have spent
  the room.
  """
  @spec release(t(), integer(), non_neg_integer()) :: {[release()], [lost()], t(), pos_integer() | nil}
  def release(%__MODULE__{} = pacer, now_ms, bank_ms) do
    {releases, lost, pacer, bank} =
      pacer |> forget_idle(now_ms) |> start_clocks(now_ms) |> drain(now_ms, bank_ms, [], [])

    wait =
      case next_wakeup(pacer, now_ms, bank) do
        nil -> nil
        at -> at - now_ms
      end

    {releases, lost, pacer, wait}
  end

  @doc """
  Every message with a line still waiting, once each: what would be lost
  unsent if the pacer went away now. A message's lines leave in order, so
  its last line waits as long as any of it does.
  """
  @spec pending(t()) :: [lost()]
  def pending(%__MODULE__{queues: queues}) do
    for {_, lanes} <- queues,
        lane <- @lanes,
        %{last?: true} = item <- Map.fetch!(lanes, lane),
        do: {item.target, item.msgid, item.verb}
  end

  @doc """
  Drops what is left of message `msgid` to the folded `key`: one of its
  lines failed to go out, so its receiver can never complete it.
  """
  @spec drop(t(), String.t(), String.t()) :: t()
  def drop(%__MODULE__{} = pacer, key, msgid) when is_binary(key) and is_binary(msgid),
    do: pacer |> forget_open(key, msgid) |> drop_queued(key, msgid)

  # The message is no longer under way in any lane of `key`.
  @spec forget_open(t(), String.t(), String.t()) :: t()
  defp forget_open(pacer, key, msgid) do
    settled = if Map.get(pacer.open, {key, :reactive}) == msgid, do: settle(pacer, key), else: pacer
    %{settled | open: Map.reject(settled.open, fn {{k, _}, m} -> k == key and m == msgid end)}
  end

  @spec drop_queued(t(), String.t(), String.t()) :: t()
  defp drop_queued(pacer, key, msgid) do
    case Map.fetch(pacer.queues, key) do
      :error ->
        pacer

      {:ok, lanes} ->
        mine = Enum.filter(lanes.text, &(&1.msgid == msgid))
        gone = Enum.flat_map(@lanes, fn lane -> Enum.filter(Map.fetch!(lanes, lane), &(&1.msgid == msgid)) end)

        %{
          pacer
          | text_cost: pacer.text_cost - Enum.sum(Enum.map(mine, & &1.cost)),
            text_messages:
              if(mine == [],
                do: pacer.text_messages,
                else: Map.update!(pacer.text_messages, key, &(&1 - Enum.count(mine, fn e -> e.last? end)))
              ),
            queues:
              Map.put(
                pacer.queues,
                key,
                Map.new(lanes, fn {lane, q} -> {lane, Enum.reject(q, &(&1.msgid == msgid))} end)
              )
        }
        |> left_a_gap(key, if(Enum.any?(gone, &olm?(&1.verb)), do: 1, else: 0))
        |> tidy(key)
    end
  end

  # A KEYS or NACK no longer under way keeps neither what it paid to go
  # ahead nor its freshness.
  @spec settle(t(), String.t()) :: t()
  defp settle(pacer, key), do: %{pacer | paid: MapSet.delete(pacer.paid, key), fresh: MapSet.delete(pacer.fresh, key)}

  # --- queueing --------------------------------------------------------

  @spec items(message(), String.t(), [line(), ...], non_neg_integer()) :: {[item(), ...], non_neg_integer()}
  defp items(message, target, lines, seq) do
    last = length(lines) - 1

    lines
    |> Enum.with_index()
    |> Enum.map_reduce(seq, fn {{body, cost}, i}, n ->
      item = %{
        seq: n,
        target: target,
        body: body,
        msgid: message.msgid,
        verb: message.verb,
        last?: i == last,
        deadline: message.deadline_ms,
        cost: cost
      }

      {item, n + 1}
    end)
  end

  @spec admits?(t(), String.t(), lane(), [item(), ...], pos_integer()) :: boolean()
  defp admits?(pacer, key, :text, _, cost) do
    pacer.text_cost + cost <= @max_backlog_ms and
      Map.get(pacer.text_messages, key, 0) + Map.get(pacer.gap, key, 0) + 1 <= @max_text_messages
  end

  defp admits?(pacer, key, lane, items, _) do
    queued(pacer) + length(items) <= @max_queued and
      length(queue_of(pacer, key, lane)) + length(items) <= @max_lane_lines
  end

  @spec queue(t(), String.t(), lane(), [item(), ...], pos_integer()) :: t()
  defp queue(pacer, key, lane, items, cost) do
    lanes = Map.get(pacer.queues, key, %{urgent: [], reactive: [], text: []})
    pacer = %{pacer | queues: Map.put(pacer.queues, key, Map.update!(lanes, lane, &(&1 ++ items)))}

    if lane == :text do
      %{
        pacer
        | # The floor's clock starts at the next release.
          text_at: if(pacer.text_cost == 0, do: nil, else: pacer.text_at),
          text_cost: pacer.text_cost + cost,
          text_messages: Map.update(pacer.text_messages, key, 1, &(&1 + 1))
      }
    else
      pacer
    end
  end

  # The receiver skips the key of an Olm message it never gets when the
  # next one arrives; it only matters behind queued text, which an urgent
  # message may still overtake.
  @spec left_a_gap(t(), String.t(), non_neg_integer()) :: t()
  defp left_a_gap(pacer, key, messages) do
    case Map.fetch(pacer.queues, key) do
      {:ok, %{text: [_ | _]}} when messages > 0 ->
        %{pacer | gap: Map.update(pacer.gap, key, messages, &(&1 + messages))}

      _ ->
        pacer
    end
  end

  # After lines left a target's queue: no gap without text to overtake, and
  # nothing kept for a target with nothing queued.
  @spec tidy(t(), String.t()) :: t()
  defp tidy(pacer, key) do
    lanes = Map.fetch!(pacer.queues, key)
    pacer |> tidy_gap(key, lanes) |> tidy_patience(key, lanes) |> tidy_target(key, lanes)
  end

  @spec tidy_gap(t(), String.t(), lanes()) :: t()
  defp tidy_gap(pacer, key, %{text: []}), do: %{pacer | gap: Map.delete(pacer.gap, key)}
  defp tidy_gap(pacer, _, _), do: pacer

  @spec tidy_patience(t(), String.t(), lanes()) :: t()
  defp tidy_patience(pacer, key, %{reactive: []}),
    do: %{pacer | reactive_at: Map.delete(pacer.reactive_at, key), cutoff: Map.delete(pacer.cutoff, key)}

  defp tidy_patience(pacer, _, _), do: pacer

  @spec tidy_target(t(), String.t(), lanes()) :: t()
  defp tidy_target(pacer, key, %{urgent: [], reactive: [], text: []}),
    do: %{pacer | queues: Map.delete(pacer.queues, key), text_messages: Map.delete(pacer.text_messages, key)}

  defp tidy_target(pacer, _, _), do: pacer

  # --- releasing -------------------------------------------------------

  # The floor's clock, and each target's patience clock, start at the
  # first release that sees them queued; the cutoff is drawn when the
  # patience runs out.
  @spec start_clocks(t(), integer()) :: t()
  defp start_clocks(pacer, now) do
    pacer = if is_nil(pacer.text_at) and pacer.text_cost > 0, do: %{pacer | text_at: now}, else: pacer

    Enum.reduce(pacer.queues, pacer, fn
      {_, %{reactive: []}}, acc ->
        acc

      {key, _}, acc ->
        acc = %{acc | reactive_at: Map.put_new(acc.reactive_at, key, now)}

        if not Map.has_key?(acc.cutoff, key) and waited?(acc, key, now),
          do: %{acc | cutoff: Map.put(acc.cutoff, key, acc.seq), seq: acc.seq + 1},
          else: acc
    end)
  end

  # Once the bank has no room for the line whose turn it is, nothing else
  # goes either: a cheaper line slipping past would keep the dear one
  # waiting.
  @spec drain(t(), integer(), non_neg_integer(), [release()], [lost()]) ::
          {[release()], [lost()], t(), non_neg_integer()}
  defp drain(pacer, now, bank, out, lost) do
    {pacer, dead} = drop_dead(pacer, now, bank)
    lost = lost ++ dead

    with {{key, lane, head, rank}, _} <- next_head(pacer, now),
         true <- fits?(bank, head.cost, limit(lane, rank)) do
      pacer
      |> take(key, lane, head, rank, now)
      |> drain(now, bank + head.cost, [{head.target, head.msgid, head.verb, head.body} | out], lost)
    else
      _ -> {Enum.reverse(out), lost, pacer, bank}
    end
  end

  # The bookkeeping of one release, `head` of `key`'s `lane` at `rank`.
  @spec take(t(), String.t(), lane(), item(), non_neg_integer(), integer()) :: t()
  defp take(pacer, key, lane, head, rank, now) do
    q = queue_of(pacer, key, lane)

    pacer
    |> mark_fresh(key, head, rank)
    |> pay_ahead(key, q, rank, now)
    |> close_reactive(key, lane, head)
    |> pop(key, lane, tl(q))
    |> account(key, lane, head, now)
    |> mark_released(key, lane, head, now)
    |> tidy(key)
  end

  @spec mark_fresh(t(), String.t(), item(), non_neg_integer()) :: t()
  defp mark_fresh(pacer, key, %{verb: :keys}, @fresh_reactive), do: %{pacer | fresh: MapSet.put(pacer.fresh, key)}
  defp mark_fresh(pacer, _, _, _), do: pacer

  # Going ahead of the orders and of text past the floor: the rest of it
  # (the head message of `q`) is paid for, once, from URGENT's allowance.
  @spec pay_ahead(t(), String.t(), [item(), ...], non_neg_integer(), integer()) :: t()
  defp pay_ahead(pacer, key, q, rank, now) when rank in [@fresh_first, @fresh_next] do
    if MapSet.member?(pacer.paid, key),
      do: pacer,
      else: %{charge(pacer, {:paid, :urgent}, now, head_cost(q)) | paid: MapSet.put(pacer.paid, key)}
  end

  defp pay_ahead(pacer, _, _, _, _), do: pacer

  @spec close_reactive(t(), String.t(), lane(), item()) :: t()
  defp close_reactive(pacer, key, :reactive, %{last?: true}), do: settle(pacer, key)
  defp close_reactive(pacer, _, _, _), do: pacer

  @spec pop(t(), String.t(), lane(), [item()]) :: t()
  defp pop(pacer, key, lane, rest), do: %{pacer | queues: Map.update!(pacer.queues, key, &Map.put(&1, lane, rest))}

  @spec account(t(), String.t(), lane(), item(), integer()) :: t()
  defp account(pacer, key, :text, head, now) do
    %{
      pacer
      | text_cost: pacer.text_cost - head.cost,
        text_messages: Map.update!(pacer.text_messages, key, &if(head.last?, do: &1 - 1, else: &1)),
        text_at: now
    }
  end

  defp account(pacer, key, lane, head, now),
    do: pacer |> charge({key, lane}, now, head.cost) |> charge({:connection, lane}, now, head.cost)

  # Messages are queued whole, one after another: the line that ends one
  # is the open message's.
  @spec mark_released(t(), String.t(), lane(), item(), integer()) :: t()
  defp mark_released(pacer, key, lane, head, now) do
    open = if head.last?, do: Map.delete(pacer.open, {key, lane}), else: Map.put(pacer.open, {key, lane}, head.msgid)

    %{
      pacer
      | open: open,
        sent: Map.put(pacer.sent, key, [now | in_flud_window(Map.get(pacer.sent, key, []), now)]),
        served: Map.put(pacer.served, key, now)
    }
  end

  @spec charge(t(), budget_key(), integer(), pos_integer()) :: t()
  defp charge(pacer, budget, now, cost),
    do: %{pacer | spent: Map.put(pacer.spent, budget, [{now, cost} | in_budget_window(pacer, budget, now)])}

  # The line whose turn it is, `{key, lane, head, rank}` or `nil` while
  # every target waits on its window; then the earliest instant a window
  # opens (or `nil`). One urgent and one text message under way at a time:
  # a second order interleaving with the first makes both late, and text
  # messages taking turns age together past their receivers' minute.
  @spec next_head(t(), integer()) ::
          {{String.t(), lane(), item(), non_neg_integer()} | nil, integer() | nil}
  defp next_head(pacer, now) do
    under_way = for {{k, lane}, _} <- pacer.open, lane != :reactive, into: %{}, do: {lane, k}
    starved = starved?(pacer, now)

    {heads, opens} =
      Enum.reduce(pacer.queues, {[], []}, fn {key, lanes}, {heads, opens} ->
        slot = slot(pacer, key, now)

        if slot > now,
          do: {heads, [slot | opens]},
          else: {heads_of(pacer, key, lanes, under_way, starved, now) ++ heads, opens}
      end)

    best =
      case heads do
        [] ->
          nil

        _ ->
          {{rank, _, _}, key, lane, head} = Enum.min_by(heads, &elem(&1, 0))
          {key, lane, head, rank}
      end

    {best, Enum.min(opens, fn -> nil end)}
  end

  # The head of each of `key`'s lanes that may go next: none of a lane
  # whose message under way is another target's.
  @spec heads_of(t(), String.t(), lanes(), %{optional(lane()) => String.t()}, boolean(), integer()) ::
          [{{non_neg_integer(), {0 | 1, integer()}, non_neg_integer()}, String.t(), lane(), item()}]
  defp heads_of(pacer, key, lanes, under_way, starved, now) do
    for lane <- @lanes, Map.fetch!(lanes, lane) != [], Map.get(under_way, lane, key) == key do
      head = hd(Map.fetch!(lanes, lane))
      {rank(pacer, key, lane, head, starved, now), key, lane, head}
    end
  end

  # `{rank, turn, seq}`: a target never served (or forgotten) sorts before
  # every served one, whatever the monotonic clock's sign.
  @spec rank(t(), String.t(), lane(), item(), boolean(), integer()) ::
          {non_neg_integer(), {0 | 1, integer()}, non_neg_integer()}
  defp rank(pacer, key, lane, head, starved, now) do
    started = Map.get(pacer.open, {key, lane}) == head.msgid
    {lane_rank(pacer, key, lane, started, starved, now), turn(pacer, key), head.seq}
  end

  @spec lane_rank(t(), String.t(), lane(), boolean(), boolean(), integer()) :: non_neg_integer()
  # Starved, a text message under way goes before any order: its receiver
  # would drop it. One not started yields to the orders.
  defp lane_rank(_, _, :text, true, true, _), do: @starved_started
  defp lane_rank(_, _, :text, false, true, _), do: @starved_text
  defp lane_rank(_, _, :text, _, false, _), do: @text
  defp lane_rank(_, _, :urgent, true, _, _), do: @started_urgent
  defp lane_rank(pacer, key, :reactive, true, _, now), do: started_reactive_rank(pacer, key, now)
  defp lane_rank(pacer, key, lane, false, _, now), do: budget_rank(pacer, key, lane, now)

  @spec started_reactive_rank(t(), String.t(), integer()) :: non_neg_integer()
  defp started_reactive_rank(pacer, key, now) do
    cond do
      # The floor, from its own last line, before what it paid or waited:
      # those only ever raise it.
      reactive_floor?(pacer, key, now) -> @starved_started
      MapSet.member?(pacer.paid, key) -> fresh_rank(pacer, key, now)
      MapSet.member?(pacer.fresh, key) -> started_fresh(pacer, key, now)
      true -> @started_reactive
    end
  end

  # A fresh KEYS under way that started with nothing ahead, once it has
  # waited.
  @spec started_fresh(t(), String.t(), integer()) :: non_neg_integer()
  defp started_fresh(pacer, key, now),
    do: ahead(pacer, key, head_cost(queue_of(pacer, key, :reactive)), now, @started_reactive)

  # Where a fresh target's KEYS going ahead of text sorts: behind the
  # orders queued before its patience ran out, ahead of the others.
  @spec fresh_rank(t(), String.t(), integer()) :: non_neg_integer()
  defp fresh_rank(pacer, key, now), do: if(order_before?(pacer, key, now), do: @fresh_next, else: @fresh_first)

  @spec turn(t(), String.t()) :: {0 | 1, integer()}
  defp turn(pacer, key) do
    case Map.fetch(pacer.served, key) do
      {:ok, at} -> {1, at}
      :error -> {0, 0}
    end
  end

  # Where the head message of an URGENT or REACTIVE lane, not yet started,
  # goes: ahead of text if all its lines fit the target's budget and the
  # connection's, behind it if not. A target that drew nothing else from
  # the lane in the window (nothing spent, one message queued) may use the
  # connection's allowance, and its KEYS or NACK goes ahead of the rest of
  # the lane; its KEYS, once it has waited, ahead of the orders queued
  # since too, if the allowance has room for it.
  @spec budget_rank(t(), String.t(), :urgent | :reactive, integer()) :: non_neg_integer()
  defp budget_rank(pacer, key, lane, now) do
    q = queue_of(pacer, key, lane)
    {lines, cost} = head_message(q)
    spent = spent_in(pacer, {key, lane}, now)
    fresh = spent == 0 and lines == length(q)

    cond do
      past_budget?(pacer, lane, spent, cost, fresh, now) ->
        @past_budget

      lane == :urgent ->
        @urgent

      not fresh ->
        @reactive

      hd(q).verb == :keys ->
        ahead(pacer, key, cost, now, @fresh_reactive)

      true ->
        @fresh_reactive
    end
  end

  # Whether a message of `cost` overruns the target's budget, which holds
  # `spent`, or the connection's, unless a `fresh` target's allowance
  # covers it.
  @spec past_budget?(t(), :urgent | :reactive, non_neg_integer(), pos_integer(), boolean(), integer()) :: boolean()
  defp past_budget?(pacer, lane, spent, cost, fresh, now) do
    {per_target, total} = budgets(lane)

    spent + cost > per_target or
      (spent_in(pacer, {:connection, lane}, now) + cost > total and not (fresh and allowed?(pacer, lane, cost, now)))
  end

  @spec budgets(:urgent) :: {36_000, 36_000}
  @spec budgets(:reactive) :: {18_000, 22_000}
  defp budgets(:urgent), do: {@urgent_budget_ms, @urgent_budget_ms}
  defp budgets(:reactive), do: {@reactive_budget_ms, @reactive_total_ms}

  # Whether `cost` more fits the connection's budget stretched by the
  # allowance: URGENT's counts what the fresh KEYS paid to go ahead too,
  # the two sharing it.
  @spec allowed?(t(), :urgent | :reactive, pos_integer(), integer()) :: boolean()
  defp allowed?(pacer, lane, cost, now) do
    paid = if lane == :urgent, do: spent_in(pacer, {:paid, :urgent}, now), else: 0
    spent_in(pacer, {:connection, lane}, now) + cost + paid <= elem(budgets(lane), 1) + @fresh_allowance_ms
  end

  # Where a fresh target's KEYS (the rest of it, of `cost`) goes ahead of
  # text past the floor: `otherwise` before its patience is out, or while
  # URGENT's allowance has no room for it.
  @spec ahead(t(), String.t(), pos_integer(), integer(), non_neg_integer()) :: non_neg_integer()
  defp ahead(pacer, key, cost, now, otherwise) do
    if waited?(pacer, key, now) and allowed?(pacer, :urgent, cost, now),
      do: fresh_rank(pacer, key, now),
      else: otherwise
  end

  # The wakeup's expression, so that the two agree to the millisecond.
  @spec waited?(t(), String.t(), integer()) :: boolean()
  defp waited?(pacer, key, now) do
    case Map.fetch(pacer.reactive_at, key) do
      {:ok, at} -> now >= at + @fresh_patience_ms
      :error -> false
    end
  end

  # A seq is drawn when the patience runs out: the orders queued before
  # have lower ones; not drawn yet, every order is. One under way counts
  # whatever its budget, as it goes first whatever its budget (it matters
  # here only while its target's window holds it); one not started, within
  # budget.
  @spec order_before?(t(), String.t(), integer()) :: boolean()
  defp order_before?(pacer, key, now) do
    cutoff = Map.get(pacer.cutoff, key)

    Enum.any?(pacer.queues, fn {k, lanes} ->
      lanes.urgent != [] and (is_nil(cutoff) or hd(lanes.urgent).seq < cutoff) and
        (Map.has_key?(pacer.open, {k, :urgent}) or budget_rank(pacer, k, :urgent, now) == @urgent)
    end)
  end

  # When the target's last KEYS or NACK line left (`nil`: over a budget
  # window ago): the floor's clock of one under way.
  @spec last_reactive(t(), String.t()) :: integer() | nil
  defp last_reactive(pacer, key) do
    case Map.get(pacer.spent, {key, :reactive}) do
      [{at, _} | _] -> at
      _ -> nil
    end
  end

  # The wakeup's expression, so that the two agree to the millisecond.
  @spec reactive_floor?(t(), String.t(), integer()) :: boolean()
  defp reactive_floor?(pacer, key, now) do
    case last_reactive(pacer, key) do
      nil -> true
      at -> now >= at + @text_floor_ms
    end
  end

  # The wakeup's expression, so that the two agree to the millisecond.
  @spec starved?(t(), integer()) :: boolean()
  defp starved?(pacer, now),
    do: pacer.text_cost > 0 and not is_nil(pacer.text_at) and now >= pacer.text_at + @text_floor_ms

  # The rest of a KEYS or NACK under way past its floor, and a first
  # contact's KEYS going ahead of every order, take the reserve as the
  # orders do; one behind an older order leaves it to that order.
  @spec limit(lane(), non_neg_integer()) :: limit()
  defp limit(:urgent, _), do: Client.fake_lag_ceiling_ms()
  defp limit(:reactive, rank) when rank in [@starved_started, @fresh_first], do: Client.fake_lag_ceiling_ms()
  defp limit(_, _), do: Client.fake_lag_ceiling_ms() - @reserve_ms

  # One expression for the fit and the wait, so that they agree to the
  # millisecond. A line dearer than the limit goes at an empty bank.
  @spec fits?(non_neg_integer(), pos_integer(), limit()) :: boolean()
  defp fits?(bank, cost, limit), do: room_wait(bank, cost, limit) == 0

  @spec room_wait(non_neg_integer(), pos_integer(), limit()) :: non_neg_integer()
  defp room_wait(bank, cost, limit), do: max(0, bank + cost - max(limit, cost))

  @spec slot(t(), String.t(), integer()) :: integer()
  defp slot(pacer, key, now) when is_integer(now) do
    case pacer.sent |> Map.get(key, []) |> in_flud_window(now) |> Enum.drop(@per_window - 1) do
      [] -> now
      [at | _] when is_integer(at) -> at + @window_ms
    end
  end

  @spec in_flud_window([integer()], integer()) :: [integer()]
  defp in_flud_window(sent, now), do: Enum.filter(sent, &(&1 + @window_ms > now))

  @spec in_budget_window(t(), budget_key(), integer()) :: [{integer(), pos_integer()}]
  defp in_budget_window(pacer, budget, now),
    do: pacer.spent |> Map.get(budget, []) |> Enum.filter(fn {at, _} -> at + @budget_window_ms > now end)

  # Bank the budget window `budget` holds at `now`.
  @spec spent_in(t(), budget_key(), integer()) :: non_neg_integer()
  defp spent_in(pacer, budget, now),
    do: for({_, cost} <- in_budget_window(pacer, budget, now), reduce: 0, do: (n -> n + cost))

  # `{lines, bank cost}` of a lane's head message: the rest of it, when it
  # is under way.
  @spec head_message([item(), ...]) :: {pos_integer(), pos_integer()}
  defp head_message(q) do
    {head, [last | _]} = Enum.split_while(q, &(not &1.last?))
    {length(head) + 1, Enum.sum(Enum.map([last | head], & &1.cost))}
  end

  @spec head_cost([item(), ...]) :: pos_integer()
  defp head_cost(q), do: elem(head_message(q), 1)

  @spec queue_of(t(), String.t(), lane()) :: [item()]
  defp queue_of(pacer, key, lane) do
    case Map.fetch(pacer.queues, key) do
      {:ok, lanes} -> Map.fetch!(lanes, lane)
      :error -> []
    end
  end

  @spec queued(t()) :: non_neg_integer()
  # Urgent and reactive lines waiting on the connection: what
  # `max_queued/0` bounds.
  defp queued(pacer),
    do: Enum.reduce(pacer.queues, 0, fn {_, l}, n -> n + length(l.urgent) + length(l.reactive) end)

  @spec olm?(E2e.verb()) :: boolean()
  defp olm?(verb), do: verb in [:pkmsg, :msg]

  # --- deadlines -------------------------------------------------------

  # When an urgent message of `cost` not yet started stops being worth
  # starting: its last line would leave less than the margin before
  # `deadline`. `now` once the bank already says so. One expression for
  # the drop and the wakeup, so that they agree to the millisecond.
  @spec drop_at(pos_integer(), integer(), integer(), non_neg_integer()) :: integer()
  defp drop_at(cost, deadline, now, bank)
       when is_integer(cost) and is_integer(deadline) and is_integer(now) and is_integer(bank) do
    over = cost - Client.fake_lag_ceiling_ms()

    if now + bank + over >= deadline - @ack_margin_ms,
      do: now,
      else: deadline - @ack_margin_ms - max(0, over)
  end

  # `{msgid, cost, deadline, first line}` of the urgent messages of `key`
  # not yet started that carry a deadline.
  @spec unstarted_deadlines(t(), String.t(), lanes()) :: [{String.t(), pos_integer(), integer(), item()}]
  defp unstarted_deadlines(pacer, key, lanes) do
    started = Map.get(pacer.open, {key, :urgent})

    lanes.urgent
    |> Enum.chunk_by(& &1.msgid)
    |> Enum.flat_map(fn [first | _] = message ->
      if first.deadline != nil and first.msgid != started,
        do: [{first.msgid, Enum.sum(Enum.map(message, & &1.cost)), first.deadline, first}],
        else: []
    end)
  end

  # Drops the urgent messages not started that can no longer be answered
  # in time (a CHAL, or an ACK, that could not make its deadline).
  @spec drop_dead(t(), integer(), non_neg_integer()) :: {t(), [lost()]}
  defp drop_dead(pacer, now, bank) do
    Enum.reduce(Map.keys(pacer.queues), {pacer, []}, fn key, {acc, lost} ->
      {next, dead} = drop_dead_of(acc, key, now, bank)
      {next, lost ++ dead}
    end)
  end

  @spec drop_dead_of(t(), String.t(), integer(), non_neg_integer()) :: {t(), [lost()]}
  defp drop_dead_of(pacer, key, now, bank) do
    lanes = Map.fetch!(pacer.queues, key)

    gone =
      for {msgid, cost, deadline, first} <- unstarted_deadlines(pacer, key, lanes),
          now >= drop_at(cost, deadline, now, bank),
          do: {msgid, first}

    case gone do
      [] ->
        {pacer, []}

      _ ->
        ids = MapSet.new(gone, &elem(&1, 0))
        urgent = Enum.reject(lanes.urgent, &MapSet.member?(ids, &1.msgid))

        next =
          %{pacer | queues: Map.put(pacer.queues, key, %{lanes | urgent: urgent})}
          |> left_a_gap(key, Enum.count(gone, fn {_, first} -> olm?(first.verb) end))
          |> tidy(key)

        {next, Enum.map(gone, fn {_, first} -> {first.target, first.msgid, first.verb} end)}
    end
  end

  # --- forgetting and waking -------------------------------------------

  # A target gone quiet leaves nothing behind: its window once it has
  # passed, its budgets once spent, its turn once it is older than every
  # queued target's that has one. Coming back without it, it goes first,
  # as a target never served does; with it, it went first too.
  @spec forget_idle(t(), integer()) :: t()
  defp forget_idle(pacer, now) do
    queued? = &Map.has_key?(pacer.queues, &1)

    sent =
      pacer.sent
      |> Map.new(fn {k, s} -> {k, in_flud_window(s, now)} end)
      |> Map.reject(fn {k, s} -> s == [] and not queued?.(k) end)

    spent =
      pacer.spent
      |> Map.new(fn {budget, _} -> {budget, in_budget_window(pacer, budget, now)} end)
      |> Map.reject(fn {{k, _}, s} -> s == [] and not queued?.(k) end)

    oldest = pacer.served |> Map.filter(fn {k, _} -> queued?.(k) end) |> Map.values() |> Enum.min(fn -> nil end)
    served = Map.reject(pacer.served, fn {k, at} -> not queued?.(k) and (is_nil(oldest) or at <= oldest) end)

    %{pacer | sent: sent, spent: spent, served: served}
  end

  # When a release may come next: the bank's room for the line whose turn
  # it is, a window opening on another target, a budget recovering, an
  # urgent message turning too late to start and making way, a fresh KEYS's
  # patience running out or the allowance's room for it, the floor of a
  # KEYS or NACK under way, or the text floor. Never `now`.
  @spec next_wakeup(t(), integer(), non_neg_integer()) :: integer() | nil
  defp next_wakeup(pacer, now, bank) do
    {next, opens} = next_head(pacer, now)

    bank_room =
      case next do
        nil -> []
        {_, lane, head, rank} -> [now + room_wait(bank, head.cost, limit(lane, rank))]
      end

    later =
      Enum.flat_map(pacer.queues, fn {key, lanes} ->
        lane_wakes(pacer, key, lanes, now) ++
          for {_, cost, deadline, _} <- unstarted_deadlines(pacer, key, lanes), do: drop_at(cost, deadline, now, bank)
      end)

    floor = if pacer.text_cost > 0 and not is_nil(pacer.text_at), do: [pacer.text_at + @text_floor_ms], else: []

    Enum.min(List.wrap(opens) ++ bank_room ++ Enum.filter(later ++ floor, &(&1 > now)), fn -> nil end)
  end

  @spec lane_wakes(t(), String.t(), lanes(), integer()) :: [integer()]
  defp lane_wakes(pacer, key, lanes, now) do
    for lane <- [:urgent, :reactive],
        (q = Map.fetch!(lanes, lane)) != [],
        at <- head_wakes(pacer, key, lane, q, now),
        do: at
  end

  @spec head_wakes(t(), String.t(), :urgent | :reactive, [item(), ...], integer()) :: [integer()]
  defp head_wakes(pacer, key, lane, [head | _] = q, now) do
    cost = head_cost(q)

    cond do
      Map.get(pacer.open, {key, lane}) != head.msgid ->
        budget_recovers(pacer, key, lane, cost, now) ++
          if(lane == :reactive, do: patience_ends(pacer, key, cost, now), else: [])

      lane == :reactive ->
        floor = if at = last_reactive(pacer, key), do: [at + @text_floor_ms], else: []

        floor ++
          if MapSet.member?(pacer.fresh, key) and not MapSet.member?(pacer.paid, key),
            do: patience_ends(pacer, key, cost, now),
            else: []

      true ->
        []
    end
  end

  # The instants at which a message of `cost` to `key` may come within
  # budget: the target's budget fitting it, the connection's fitting it
  # with and without the allowance, the target's emptying (which may grant
  # the allowance and the precedence). Waking at one where nothing changes
  # costs nothing; missing one makes a line late.
  @spec budget_recovers(t(), String.t(), :urgent | :reactive, pos_integer(), integer()) :: [integer()]
  defp budget_recovers(pacer, key, lane, cost, now) do
    {per_target, total} = budgets(lane)
    mine = {key, lane}
    conn = {:connection, lane}
    allowed = if lane == :urgent, do: [conn, {:paid, :urgent}], else: [conn]

    [
      ages_out(pacer, [mine], now, &(&1 + cost <= per_target)),
      ages_out(pacer, [conn], now, &(&1 + cost <= total)),
      ages_out(pacer, allowed, now, &(&1 + cost <= total + @fresh_allowance_ms)),
      ages_out(pacer, [mine], now, &(&1 == 0))
    ]
  end

  # The instants at which a fresh target's KEYS (the rest of it) of `cost`
  # may go ahead: its patience running out, and URGENT's allowance fitting
  # it.
  @spec patience_ends(t(), String.t(), pos_integer(), integer()) :: [integer()]
  defp patience_ends(pacer, key, cost, now) do
    fits = &(&1 + cost <= @urgent_budget_ms + @fresh_allowance_ms)
    allowance = ages_out(pacer, [{:connection, :urgent}, {:paid, :urgent}], now, fits)

    if at = Map.get(pacer.reactive_at, key),
      do: [at + @fresh_patience_ms, allowance],
      else: [allowance]
  end

  # When enough of the releases in the budget windows `budgets` age out for
  # `ok` to hold of what is left of them together: `now` if it holds
  # already.
  @spec ages_out(t(), [budget_key()], integer(), (non_neg_integer() -> boolean())) :: integer()
  defp ages_out(pacer, budgets, now, ok) do
    entries = budgets |> Enum.flat_map(&in_budget_window(pacer, &1, now)) |> Enum.sort()
    age_out(entries, entries |> Enum.map(&elem(&1, 1)) |> Enum.sum(), now, ok)
  end

  @spec age_out([{integer(), pos_integer()}], non_neg_integer(), integer(), (non_neg_integer() -> boolean())) ::
          integer()
  defp age_out([], _, at, _) when is_integer(at), do: at

  defp age_out([{t, cost} | rest], left, at, ok) when is_integer(t) and is_integer(at) do
    if ok.(left), do: at, else: age_out(rest, left - cost, t + @budget_window_ms, ok)
  end
end
