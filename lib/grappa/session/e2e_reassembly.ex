defmodule Grappa.Session.E2eReassembly do
  @moduledoc """
  Buffers the fragments of inbound E2E messages until each is whole
  (issue 2430). Pure data; `Grappa.Session.Server` holds one in its state
  and drives the clock.

  A logical message is keyed by `(sender, msgid)` — `sender` being the
  sender's nick folded by the CALLER (`Session.Server` folds it with the
  network's casemapping, like every other nick KEY). The draft says
  "sender key"; before decryption the only sender identity the relay has
  is the nick, and the payload's own identity block is the endpoints'
  business.

  ## Caps (the draft's anti-flood rules, all enforced here)

    * a message that gets no new fragment for 60 s is discarded
      (`expire/2`). The window counts from the LAST accepted fragment, not
      the first (vjt's ruling on 2430, option A): senders pace against
      bahamut's fake lag, which drips a long message at one line per 5 s,
      so a window counted from the first fragment would discard every
      message longer than about 13 lines. A repeated index does not reset
      the clock; only a fragment that adds to the message does;
    * at most `Grappa.IRC.E2e.max_fragments/0` fragments (the parser
      already refuses a larger `n`);
    * at most `Grappa.IRC.E2e.max_payload_bytes/0` (32 KiB) buffered per
      sender across all of its messages in flight — the bot side picked
      the same 32 KiB;
    * at most 1024 KiB buffered in total, so many senders cannot add up
      to what one is refused.

  Each fragment is charged its chunk plus a fixed 64-byte overhead
  against both caps. Counting chunk bytes alone let 1-byte chunks pile up
  ~32k map entries per sender for 32 KiB of "data"; a legitimate 64-line
  message on a 512-byte wire is ~28 KiB with the overhead, under the cap.

  A fragment refused by a cap takes the message it belongs to with it:
  that message can no longer complete, and keeping it would hold its bytes
  against the sender's next messages until it expired.

  A fragment that contradicts the message it claims to belong to (another
  verb, another total, another `from` or `to`) drops the whole message: there is no telling which
  side of the contradiction is the honest one, and an incomplete message
  is discarded anyway. A repeated index is ignored (first one wins), which
  also makes a duplicated line on the wire harmless.

  Incomplete is never delivered: the client either gets the whole payload
  or nothing.
  """

  alias Grappa.IRC.E2e
  alias Grappa.IRC.E2e.Fragment

  @timeout_ms 60_000
  @max_total_bytes 1024 * 1024
  @fragment_overhead_bytes 64

  @typedoc "A whole message, ready to hand to the client: its verb, msgid, addresses and payload."
  @type message :: %{
          verb: E2e.verb(),
          msgid: String.t(),
          from: E2e.address(),
          to: E2e.address(),
          payload: String.t()
        }

  @typedoc "Why a fragment was not buffered (or what it took down with it)."
  @type drop_reason :: :sender_cap | :total_cap | :inconsistent

  @typep entry :: %{
           verb: E2e.verb(),
           total: pos_integer(),
           from: E2e.address(),
           to: E2e.address(),
           parts: %{pos_integer() => String.t()},
           bytes: non_neg_integer(),
           last_ms: integer()
         }

  @enforce_keys [:entries, :sender_bytes, :total_bytes]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          entries: %{{String.t(), String.t()} => entry()},
          sender_bytes: %{String.t() => pos_integer()},
          total_bytes: non_neg_integer()
        }

  @doc "How long a message may go without a new fragment, in ms."
  @spec timeout_ms() :: 60_000
  def timeout_ms, do: @timeout_ms

  @doc "An empty buffer."
  @spec new() :: t()
  # Same call as `Grappa.IRC.FakeLag.new/0`: the success typing is the
  # empty singleton, and the result is stored in a field typed `t()`.
  @dialyzer {:nowarn_function, new: 0}
  def new, do: %__MODULE__{entries: %{}, sender_bytes: %{}, total_bytes: 0}

  @doc "True when nothing is buffered — the caller stops its sweep timer."
  @spec empty?(t()) :: boolean()
  def empty?(%__MODULE__{entries: entries}), do: map_size(entries) == 0

  @doc """
  Adds one fragment from `sender` at monotonic time `now_ms`.

    * `{:complete, message, buffer}` — this fragment finished a message
      (a single-fragment message completes at once and is never buffered);
    * `{:pending, buffer}` — buffered, or a repeated index ignored;
    * `{:dropped, reason, buffer}` — refused by a cap, or it contradicted
      its message and the message went with it.

  The caller runs `expire/2` first; this function does not look at the
  age of anything.
  """
  @spec put(t(), String.t(), Fragment.t(), integer()) ::
          {:complete, message(), t()} | {:pending, t()} | {:dropped, drop_reason(), t()}
  def put(%__MODULE__{} = buffer, _, %Fragment{total: 1} = fragment, _) do
    {:complete, message(fragment.msgid, fragment, fragment.chunk), buffer}
  end

  def put(%__MODULE__{} = buffer, sender, %Fragment{} = fragment, now_ms) when is_binary(sender) do
    key = {sender, fragment.msgid}

    case Map.fetch(buffer.entries, key) do
      :error -> add(buffer, sender, key, new_entry(fragment, now_ms), fragment, now_ms)
      {:ok, entry} -> extend(buffer, sender, key, entry, fragment, now_ms)
    end
  end

  @doc """
  True while a message of `verb` from the folded `sender` is part-way
  through reassembly at `now_ms`. The session asks it before sending a
  client's KEYREQ: cicchetto never sees fragments, so the rule that an
  asker does not ask again while a KEYS is still arriving is grappa's to
  keep for it (wire v2, 2430 comment 6346384093, O2 (b)). A message whose
  last fragment is `timeout_ms/0` old is no longer arriving, whether or not
  `expire/2` has dropped it yet: the sweep runs once a minute, and the
  client's KEYREQ must not wait on it.
  """
  @spec pending?(t(), String.t(), E2e.verb(), integer()) :: boolean()
  def pending?(%__MODULE__{entries: entries}, sender, verb, now_ms) when is_binary(sender) and is_integer(now_ms),
    do:
      Enum.any?(entries, fn {{from, _}, entry} ->
        from == sender and entry.verb == verb and now_ms - entry.last_ms < @timeout_ms
      end)

  @doc """
  Discards every message whose last accepted fragment is `timeout_ms/0` or
  more old at `now_ms`. Returns the buffer and how many messages went.
  """
  @spec expire(t(), integer()) :: {t(), non_neg_integer()}
  def expire(%__MODULE__{} = buffer, now_ms) do
    {stale, _} = Enum.split_with(buffer.entries, fn {_, entry} -> now_ms - entry.last_ms >= @timeout_ms end)
    {Enum.reduce(stale, buffer, fn {key, _}, acc -> remove(acc, key) end), length(stale)}
  end

  @spec new_entry(Fragment.t(), integer()) :: entry()
  defp new_entry(fragment, now_ms),
    do: %{
      verb: fragment.verb,
      total: fragment.total,
      from: fragment.from,
      to: fragment.to,
      parts: %{},
      bytes: 0,
      last_ms: now_ms
    }

  @spec extend(t(), String.t(), {String.t(), String.t()}, entry(), Fragment.t(), integer()) ::
          {:complete, message(), t()} | {:pending, t()} | {:dropped, drop_reason(), t()}
  defp extend(buffer, sender, key, entry, fragment, now_ms) do
    cond do
      {entry.verb, entry.total, entry.from, entry.to} != {fragment.verb, fragment.total, fragment.from, fragment.to} ->
        {:dropped, :inconsistent, remove(buffer, key)}

      Map.has_key?(entry.parts, fragment.index) ->
        {:pending, buffer}

      true ->
        add(buffer, sender, key, entry, fragment, now_ms)
    end
  end

  @spec add(t(), String.t(), {String.t(), String.t()}, entry(), Fragment.t(), integer()) ::
          {:complete, message(), t()} | {:pending, t()} | {:dropped, drop_reason(), t()}
  defp add(buffer, sender, key, entry, fragment, now_ms) do
    size = byte_size(fragment.chunk) + @fragment_overhead_bytes
    sender_bytes = Map.get(buffer.sender_bytes, sender, 0) + size

    # `remove/2` is a no-op for a message not buffered yet.
    cond do
      sender_bytes > E2e.max_payload_bytes() ->
        {:dropped, :sender_cap, remove(buffer, key)}

      buffer.total_bytes + size > @max_total_bytes ->
        {:dropped, :total_cap, remove(buffer, key)}

      true ->
        entry = %{
          entry
          | parts: Map.put(entry.parts, fragment.index, fragment.chunk),
            bytes: entry.bytes + size,
            last_ms: now_ms
        }

        buffer = put_entry(buffer, sender, key, entry, size)

        if map_size(entry.parts) == entry.total do
          {:complete, assemble(key, entry), remove(buffer, key)}
        else
          {:pending, buffer}
        end
    end
  end

  @spec assemble({String.t(), String.t()}, entry()) :: message()
  defp assemble({_, msgid}, entry),
    do: message(msgid, entry, Enum.map_join(1..entry.total, &Map.fetch!(entry.parts, &1)))

  @spec message(String.t(), Fragment.t() | entry(), String.t()) :: message()
  defp message(msgid, %{verb: verb, from: from, to: to}, payload),
    do: %{verb: verb, msgid: msgid, from: from, to: to, payload: payload}

  @spec put_entry(t(), String.t(), {String.t(), String.t()}, entry(), pos_integer()) :: t()
  defp put_entry(buffer, sender, key, entry, size) do
    %{
      buffer
      | entries: Map.put(buffer.entries, key, entry),
        sender_bytes: Map.update(buffer.sender_bytes, sender, size, &(&1 + size)),
        total_bytes: buffer.total_bytes + size
    }
  end

  @spec remove(t(), {String.t(), String.t()}) :: t()
  defp remove(buffer, {sender, _} = key) do
    case Map.pop(buffer.entries, key) do
      {nil, _} ->
        buffer

      {entry, entries} ->
        sender_bytes =
          case Map.fetch!(buffer.sender_bytes, sender) - entry.bytes do
            0 -> Map.delete(buffer.sender_bytes, sender)
            left -> Map.put(buffer.sender_bytes, sender, left)
          end

        %{buffer | entries: entries, sender_bytes: sender_bytes, total_bytes: buffer.total_bytes - entry.bytes}
    end
  end
end
