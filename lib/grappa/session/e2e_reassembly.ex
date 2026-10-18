defmodule Grappa.Session.E2EReassembly do
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

    * a message not complete within 60 s of its FIRST fragment is
      discarded (`expire/2`);
    * at most `Grappa.IRC.E2E.max_fragments/0` fragments (the parser
      already refuses a larger `n`);
    * at most 32 KiB of chunks buffered per sender across all of its
      messages in flight — the bot side picked the same 32 KiB;
    * at most 1024 KiB buffered in total, so many senders cannot add up
      to what one is refused.

  A fragment that contradicts the message it claims to belong to (another
  verb, another total) drops the whole message: there is no telling which
  side of the contradiction is the honest one, and an incomplete message
  is discarded anyway. A repeated index is ignored (first one wins), which
  also makes a duplicated line on the wire harmless.

  Incomplete is never delivered: the client either gets the whole payload
  or nothing.
  """

  alias Grappa.IRC.E2E
  alias Grappa.IRC.E2E.Fragment

  @timeout_ms 60_000
  @max_sender_bytes 32 * 1024
  @max_total_bytes 1024 * 1024

  @typedoc "A whole message, ready to hand to the client."
  @type message :: %{verb: E2E.verb(), msgid: String.t(), payload: String.t()}

  @typedoc "Why a fragment was not buffered (or what it took down with it)."
  @type drop_reason :: :sender_cap | :total_cap | :inconsistent

  @typep entry :: %{
           verb: E2E.verb(),
           total: pos_integer(),
           parts: %{pos_integer() => String.t()},
           bytes: non_neg_integer(),
           first_ms: integer()
         }

  @enforce_keys [:entries, :sender_bytes, :total_bytes]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          entries: %{{String.t(), String.t()} => entry()},
          sender_bytes: %{String.t() => pos_integer()},
          total_bytes: non_neg_integer()
        }

  @doc "How long a message may take to complete, in ms."
  @spec timeout_ms() :: pos_integer()
  def timeout_ms, do: @timeout_ms

  @doc "An empty buffer."
  @spec new() :: t()
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
    {:complete, %{verb: fragment.verb, msgid: fragment.msgid, payload: fragment.chunk}, buffer}
  end

  def put(%__MODULE__{} = buffer, sender, %Fragment{} = fragment, now_ms) when is_binary(sender) do
    key = {sender, fragment.msgid}

    case Map.fetch(buffer.entries, key) do
      :error -> add(buffer, sender, key, new_entry(fragment, now_ms), fragment)
      {:ok, entry} -> extend(buffer, sender, key, entry, fragment)
    end
  end

  @doc """
  Discards every message whose first fragment is older than
  `timeout_ms/0` at `now_ms`. Returns the buffer and how many messages went.
  """
  @spec expire(t(), integer()) :: {t(), non_neg_integer()}
  def expire(%__MODULE__{} = buffer, now_ms) do
    {stale, _} = Enum.split_with(buffer.entries, fn {_, entry} -> now_ms - entry.first_ms >= @timeout_ms end)
    {Enum.reduce(stale, buffer, fn {key, _}, acc -> remove(acc, key) end), length(stale)}
  end

  @spec new_entry(Fragment.t(), integer()) :: entry()
  defp new_entry(fragment, now_ms),
    do: %{verb: fragment.verb, total: fragment.total, parts: %{}, bytes: 0, first_ms: now_ms}

  @spec extend(t(), String.t(), {String.t(), String.t()}, entry(), Fragment.t()) ::
          {:complete, message(), t()} | {:pending, t()} | {:dropped, drop_reason(), t()}
  defp extend(buffer, sender, key, entry, fragment) do
    cond do
      entry.verb != fragment.verb or entry.total != fragment.total ->
        {:dropped, :inconsistent, remove(buffer, key)}

      Map.has_key?(entry.parts, fragment.index) ->
        {:pending, buffer}

      true ->
        add(buffer, sender, key, entry, fragment)
    end
  end

  @spec add(t(), String.t(), {String.t(), String.t()}, entry(), Fragment.t()) ::
          {:complete, message(), t()} | {:pending, t()} | {:dropped, drop_reason(), t()}
  defp add(buffer, sender, key, entry, fragment) do
    size = byte_size(fragment.chunk)
    sender_bytes = Map.get(buffer.sender_bytes, sender, 0) + size

    cond do
      sender_bytes > @max_sender_bytes ->
        {:dropped, :sender_cap, buffer}

      buffer.total_bytes + size > @max_total_bytes ->
        {:dropped, :total_cap, buffer}

      true ->
        entry = %{entry | parts: Map.put(entry.parts, fragment.index, fragment.chunk), bytes: entry.bytes + size}
        buffer = put_entry(buffer, sender, key, entry, size)

        if map_size(entry.parts) == entry.total do
          {:complete, assemble(key, entry), remove(buffer, key)}
        else
          {:pending, buffer}
        end
    end
  end

  @spec assemble({String.t(), String.t()}, entry()) :: message()
  defp assemble({_, msgid}, entry) do
    payload = Enum.map_join(1..entry.total, &Map.fetch!(entry.parts, &1))
    %{verb: entry.verb, msgid: msgid, payload: payload}
  end

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
