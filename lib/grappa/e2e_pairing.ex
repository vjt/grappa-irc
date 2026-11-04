defmodule Grappa.E2ePairing do
  @moduledoc """
  The blind relay two devices of one account pair through (grappa-irc#2430,
  slice X1).

  The device showing a pairing QR opens a rendezvous. The QR carries the
  rendezvous id and that device's ephemeral Curve25519 key, both public,
  in the URL fragment. A second device of the SAME subject scans it, joins,
  and the two exchange opaque messages through here until one of them
  closes the rendezvous or it expires. grappa never reads a payload: the
  channel is encrypted end to end between the two devices (vodozemac's
  ECIES, the MSC4108 shape), and the 2-digit check code both screens show
  is what defeats a grappa in the middle. The joiner speaks first (the
  ECIES outbound side), then either side may post.

  ## The two sides

  Each side is the auth session (`Grappa.Accounts.Session` id) of one
  device: the creator's at open, the joiner's at join. Nothing secret
  travels to tell them apart, and a device cannot join its own rendezvous.
  A rendezvous belongs to one subject: to every other subject its id is
  `:not_found`, the same answer as an id that never existed.

  ## Limits

  300 s to live, at most one joiner, 16 KiB per message, 64 KiB and 64
  messages per rendezvous, one live rendezvous per subject (a new open
  replaces the old one, `:replaced`), and a token bucket on opens. A
  payload is base64 text: the ECIES messages are, and nothing else needs
  to pass.

  ## Doors

  `GrappaWeb.E2ePairingController` carries the verbs and the message
  fetch. Every message and every close is also announced on the subject's
  user topic (`Grappa.E2ePairing.Wire`), which is how a device hears of it
  without polling. A message's push carries no payload: the user topic
  reaches every device of the account, and the fetch answers the two
  sides alone.

  ## The offer (issue 2537)

  A creator may open with its ephemeral Curve25519 key, the public half of
  the code its QR shows. Then the rendezvous is OFFERED: announced on the
  user topic with that key, so another device of the account can join
  without a scan or a copied link (cic shows it a banner, never joins on
  its own: one joiner per rendezvous, and a forgotten tab would win). Until
  someone joins, `offer/1` answers it, which is what a device that logs in
  meanwhile reads (the user-topic join snapshot and `GET
  /e2e/pairings/offer`). The key is public, like everything else a QR
  carries, and the push reaches the account's own devices alone.

  ## Ephemeral by design

  In memory only. A restart drops every rendezvous, and the user starts
  the pairing again: nothing in it outlives the five minutes anyway.
  """
  use GenServer

  use Boundary,
    top_level?: true,
    deps: [Grappa.PubSub, Grappa.RateLimit, Grappa.Subject],
    exports: [Message, Rendezvous, Wire]

  alias Grappa.E2ePairing.{Message, Rendezvous, Wire}
  alias Grappa.PubSub.Topic
  alias Grappa.RateLimit.TokenBucket
  alias Grappa.Subject

  @ttl_ms 300_000
  @max_message_bytes 16_384
  @max_total_bytes 65_536
  @max_messages 64
  @open_burst 5
  @open_refill_per_sec 1 / 60
  @payload_format ~r/\A[A-Za-z0-9+\/_-]+={0,2}\z/
  # A Curve25519 public key: 32 bytes, standard base64 without padding, as
  # vodozemac writes it and the QR code carries it.
  @curve_format ~r/\A[A-Za-z0-9+\/]{43}\z/

  @typedoc """
  The relay's state: every live rendezvous, by id. Named so the hot-deploy
  preflight sees it (`Grappa.HotReload.LongLivedModules`): a field added to
  `Rendezvous` is a shape change for every rendezvous already held, as
  `curve` was (issue 2537).
  """
  @type t :: %{optional(String.t()) => Rendezvous.t()}

  @spec ttl_ms() :: unquote(@ttl_ms)
  def ttl_ms, do: @ttl_ms

  @spec max_message_bytes() :: unquote(@max_message_bytes)
  def max_message_bytes, do: @max_message_bytes

  @spec max_total_bytes() :: unquote(@max_total_bytes)
  def max_total_bytes, do: @max_total_bytes

  @spec max_messages() :: unquote(@max_messages)
  def max_messages, do: @max_messages

  @spec open_burst() :: unquote(@open_burst)
  def open_burst, do: @open_burst

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc """
  Open a rendezvous with `session_id` as its creator, replacing the
  subject's live one if any. `topic_label` names the subject's user topic.
  With the creator's ephemeral key (`curve`, nil for none) the rendezvous
  is offered to the account's other devices; a malformed key is refused
  before it costs an open.
  """
  @spec open(Subject.t(), String.t(), String.t(), term()) ::
          {:ok, Rendezvous.t()} | {:error, Ecto.Changeset.t() | :rate_limited}
  def open(subject, topic_label, session_id, curve)
      when is_binary(topic_label) and is_binary(session_id) do
    with {:ok, curve} <- validate_curve(curve),
         :ok <- TokenBucket.take(:e2e_pairing_open, subject, @open_burst, @open_refill_per_sec) do
      GenServer.call(__MODULE__, {:open, subject, topic_label, session_id, curve})
    end
  end

  @doc """
  The subject's offered rendezvous: opened with a key, nobody joined yet,
  and not past its ttl. nil when there is none.
  """
  @spec offer(Subject.t()) :: Rendezvous.t() | nil
  def offer(subject),
    do: GenServer.call(__MODULE__, {:offer, subject, System.monotonic_time(:millisecond)})

  @doc "Join the rendezvous `id` with `session_id` as its joiner."
  @spec join(Subject.t(), String.t(), String.t()) ::
          {:ok, Rendezvous.t()}
          | {:error, :not_found | :pairing_already_joined | :pairing_own_rendezvous}
  def join(subject, session_id, id) when is_binary(session_id) and is_binary(id),
    do: GenServer.call(__MODULE__, {:join, subject, session_id, id})

  @doc """
  Post an opaque `payload` from `session_id`'s side. The creator posts only
  once someone has joined.
  """
  @spec post(Subject.t(), String.t(), String.t(), term()) ::
          {:ok, Message.t()}
          | {:error,
             Ecto.Changeset.t()
             | :not_found
             | :pairing_not_a_party
             | :pairing_not_joined
             | :pairing_full}
  def post(subject, session_id, id, payload) when is_binary(session_id) and is_binary(id) do
    with {:ok, payload} <- validate_payload(payload) do
      GenServer.call(__MODULE__, {:post, subject, session_id, id, payload})
    end
  end

  @doc "The messages the other side posted after `after_seq`, oldest first."
  @spec messages(Subject.t(), String.t(), String.t(), non_neg_integer()) ::
          {:ok, [Message.t()]} | {:error, :not_found | :pairing_not_a_party}
  def messages(subject, session_id, id, after_seq)
      when is_binary(session_id) and is_binary(id) and is_integer(after_seq) and after_seq >= 0,
      do: GenServer.call(__MODULE__, {:messages, subject, session_id, id, after_seq})

  @doc "Close the rendezvous, for both sides."
  @spec close(Subject.t(), String.t(), String.t()) :: :ok | {:error, :not_found | :pairing_not_a_party}
  def close(subject, session_id, id) when is_binary(session_id) and is_binary(id),
    do: GenServer.call(__MODULE__, {:close, subject, session_id, id})

  @doc false
  # The test seam for expiry: close every rendezvous whose ttl ended by
  # `now` (monotonic ms). Each rendezvous's own timer does this in
  # production.
  @spec sweep(integer()) :: :ok
  def sweep(now) when is_integer(now), do: GenServer.call(__MODULE__, {:sweep, now})

  # `empty_values: []`: a blank key is a malformed one, not an absent one.
  defp validate_curve(nil), do: {:ok, nil}

  defp validate_curve(curve) do
    changeset =
      {%{}, %{curve: :string}}
      |> Ecto.Changeset.cast(%{curve: curve}, [:curve], empty_values: [])
      |> Ecto.Changeset.validate_required([:curve])
      |> Ecto.Changeset.validate_format(:curve, @curve_format)

    with {:ok, %{curve: c}} <- Ecto.Changeset.apply_action(changeset, :insert), do: {:ok, c}
  end

  defp validate_payload(payload) do
    changeset =
      {%{}, %{payload: :string}}
      |> Ecto.Changeset.cast(%{payload: payload}, [:payload])
      |> Ecto.Changeset.validate_required([:payload])
      |> Ecto.Changeset.validate_length(:payload, max: @max_message_bytes, count: :bytes)
      |> Ecto.Changeset.validate_format(:payload, @payload_format)

    with {:ok, %{payload: p}} <- Ecto.Changeset.apply_action(changeset, :insert), do: {:ok, p}
  end

  # --- server -------------------------------------------------------------

  @impl GenServer
  def init(state), do: {:ok, state}

  @impl GenServer
  def handle_call({:open, subject, topic_label, session_id, curve}, _, state) do
    state =
      case Enum.find(state, fn {_, r} -> r.subject == subject end) do
        {_, old} -> drop(state, old, :replaced)
        nil -> state
      end

    r = Rendezvous.new(subject, topic_label, session_id, @ttl_ms, curve)
    Process.send_after(self(), {:expire, r.id}, @ttl_ms)
    if curve != nil, do: :ok = broadcast(r, Wire.offered_payload(r))
    {:reply, {:ok, r}, Map.put(state, r.id, r)}
  end

  def handle_call({:offer, subject, now}, _, state) do
    offer =
      state
      |> Map.values()
      |> Enum.find(&(&1.subject == subject and &1.curve != nil and &1.joiner == nil and &1.expires_at_ms > now))

    {:reply, offer, state}
  end

  def handle_call({:join, subject, session_id, id}, _, state) do
    with {:ok, r} <- find(state, subject, id),
         :ok <- joinable(r, session_id) do
      r = %{r | joiner: session_id}
      {:reply, {:ok, r}, Map.put(state, id, r)}
    else
      {:error, _} = err -> {:reply, err, state}
    end
  end

  def handle_call({:post, subject, session_id, id, payload}, _, state) do
    with {:ok, r} <- find(state, subject, id),
         {:ok, side} <- side(r, session_id),
         :ok <- may_post(r, side, payload) do
      msg = %Message{seq: length(r.messages) + 1, from: side, payload: payload}
      r = %{r | messages: [msg | r.messages], bytes: r.bytes + byte_size(payload)}
      :ok = broadcast(r, Wire.message_payload(r.id, msg))
      {:reply, {:ok, msg}, Map.put(state, id, r)}
    else
      {:error, _} = err -> {:reply, err, state}
    end
  end

  def handle_call({:messages, subject, session_id, id, after_seq}, _, state) do
    with {:ok, r} <- find(state, subject, id),
         {:ok, side} <- side(r, session_id) do
      msgs = r.messages |> Enum.filter(&(&1.from != side and &1.seq > after_seq)) |> Enum.reverse()
      {:reply, {:ok, msgs}, state}
    else
      {:error, _} = err -> {:reply, err, state}
    end
  end

  def handle_call({:close, subject, session_id, id}, _, state) do
    with {:ok, r} <- find(state, subject, id),
         {:ok, _} <- side(r, session_id) do
      {:reply, :ok, drop(state, r, :closed)}
    else
      {:error, _} = err -> {:reply, err, state}
    end
  end

  def handle_call({:sweep, now}, _, state), do: {:reply, :ok, expire(state, now)}

  @impl GenServer
  def handle_info({:expire, _}, state),
    do: {:noreply, expire(state, System.monotonic_time(:millisecond))}

  # --- helpers ------------------------------------------------------------

  defp find(state, subject, id) do
    case Map.fetch(state, id) do
      {:ok, %Rendezvous{subject: ^subject} = r} -> {:ok, r}
      _ -> {:error, :not_found}
    end
  end

  defp joinable(%Rendezvous{joiner: nil, creator: creator}, session_id) when creator != session_id,
    do: :ok

  defp joinable(%Rendezvous{joiner: nil}, _), do: {:error, :pairing_own_rendezvous}
  defp joinable(%Rendezvous{}, _), do: {:error, :pairing_already_joined}

  defp side(%Rendezvous{} = r, session_id) do
    case Rendezvous.role(r, session_id) do
      nil -> {:error, :pairing_not_a_party}
      side -> {:ok, side}
    end
  end

  defp may_post(%Rendezvous{joiner: nil}, :creator, _), do: {:error, :pairing_not_joined}

  defp may_post(%Rendezvous{} = r, _, payload) do
    if length(r.messages) < @max_messages and r.bytes + byte_size(payload) <= @max_total_bytes,
      do: :ok,
      else: {:error, :pairing_full}
  end

  defp expire(state, now) do
    state
    |> Map.values()
    |> Enum.filter(&(&1.expires_at_ms <= now))
    |> Enum.reduce(state, &drop(&2, &1, :expired))
  end

  defp drop(state, %Rendezvous{} = r, reason) do
    :ok = broadcast(r, Wire.closed_payload(r.id, reason))
    Map.delete(state, r.id)
  end

  # One process holds every account's rendezvous, so a failed broadcast must
  # not crash it: that would end them all for one lost push. The failure is
  # not silent, `Grappa.PubSub.broadcast_event/2` emits its telemetry, and a
  # client recovers what the push would have said by fetching, as it does
  # on every user-topic join.
  defp broadcast(%Rendezvous{topic_label: label}, payload) do
    _ = Grappa.PubSub.broadcast_event(Topic.user(label), payload)
    :ok
  end
end
