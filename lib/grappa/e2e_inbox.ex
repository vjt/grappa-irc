defmodule Grappa.E2eInbox do
  @moduledoc """
  The offline queue for end-to-end encrypted queries (issue 2430), one
  per device (multi-device, wire v2).

  A peer's whole message — reassembled from its IRC lines by
  `Grappa.Session.Server`, still ciphertext — is put in the queue of the
  device its frame names (`<to>`), or of every listed device when it names
  `*`: such a message carries one encrypted body per device, and each
  device decrypts only its own. The session then pushes each row to the
  subject's clients with its `id` and its device. The device that has read
  it acknowledges the id and the row is deleted. A device that was not
  connected fetches what is waiting when it connects. Delivery is
  therefore at least once: a device that read a message but whose
  acknowledgement was lost sees it again, and tells it from a new one by
  the id, which is never reused.

  Every message is queued, connected client or not. The spec asks for a
  queue "while no cicchetto is connected"; queueing always is the same
  promise with one path instead of two, and it also covers the client that
  is connected but never got to the message (a tab in the background, a
  reload mid-push).

  This is NOT scrollback. Nothing here is ever searched, pushed or shown as
  text, and grappa never reads a payload: it holds no key.

  ## Bounds

  Each row is charged its payload plus `row_overhead_bytes/0`, so a flood
  of tiny messages is bounded too. A device's queue holds at most
  `max_bytes/0`, and one sender (case-folded) at most `max_sender_bytes/0`
  of it, so one nick cannot fill the queue against everybody else. It is
  per NICK, the only identity grappa sees: a peer using several nicks can
  still fill the whole queue. Past either bound `put/2` refuses with
  `{:error, :full}`; a message to `*` is refused only at the devices whose
  queue is full.

  A row older than `ttl_seconds/0` is dropped by `expire/3`, which the
  session runs; the session then tells the recipient — and only the
  recipient — who sent messages that a device never read.

  ## Boundary

  Deps: `Grappa.E2eKeys` (the device a queue belongs to), `Grappa.IRC`
  (the nick fold and the E2E wire rules the schema validates),
  `Grappa.Repo`, `Grappa.Subject`.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.E2eKeys, Grappa.IRC, Grappa.Repo, Grappa.Subject],
    exports: [Entry]

  import Ecto.Query

  alias Grappa.E2eInbox.Entry
  alias Grappa.E2eKeys.Device
  alias Grappa.IRC.{E2e, Identifier}
  alias Grappa.{Repo, Subject}

  require Identifier

  @max_bytes 4 * 1024 * 1024
  @max_sender_bytes 1024 * 1024
  @row_overhead_bytes 256
  @page_size 100
  @ttl_seconds 7 * 24 * 60 * 60

  # The two verbs that carry something a person wrote. Key material and
  # NACKs expire too, but nobody is told about them and nothing is pushed
  # for them: they are the protocol talking to itself.
  @message_verbs [:pkmsg, :msg]

  @typedoc """
  What `put/2` stores: one whole message, as the session reassembled it,
  or a copy of one the subject sent from another device (`own: true`).
  """
  @type attrs :: %{
          required(:sender) => String.t(),
          required(:from_did) => E2e.address(),
          required(:verb) => Entry.verb(),
          required(:msgid) => String.t(),
          required(:payload) => String.t(),
          optional(:own) => boolean()
        }

  @doc "Bytes one device's queue may hold, overhead included."
  @spec max_bytes() :: 4_194_304
  def max_bytes, do: @max_bytes

  @doc "The share of `max_bytes/0` one sender may hold."
  @spec max_sender_bytes() :: 1_048_576
  def max_sender_bytes, do: @max_sender_bytes

  @doc "What each row costs against the bounds on top of its payload."
  @spec row_overhead_bytes() :: 256
  def row_overhead_bytes, do: @row_overhead_bytes

  @doc """
  True for the verbs that carry something a person wrote (PKMSG, MSG):
  the ones the recipient is told about when they go unread, and pushed
  for when they arrive. Key material and NACKs are neither.
  """
  @spec message_verb?(Entry.verb()) :: boolean()
  def message_verb?(verb), do: verb in @message_verbs

  @doc "The most entries `list/2` returns at once."
  @spec page_size() :: 100
  def page_size, do: @page_size

  @doc "How long a message waits for a client before it is dropped."
  @spec ttl_seconds() :: 604_800
  def ttl_seconds, do: @ttl_seconds

  @doc """
  Queues one whole message for `device`.

  `{:error, :full}` when the row would take the device's queue past
  `max_bytes/0`, or the sender's share past `max_sender_bytes/0`; the
  check and the insert are one transaction, so two arrivals cannot both
  squeeze into the last room. `{:error, :gone}` when the device was
  revoked or dropped since the caller read it: a list put or a clear can
  commit in between, and SQLite names no constraint for the foreign key it
  then refuses, so nothing else could tell. `{:error, :db_unavailable}`
  when the write lock stays taken past the retry budget.
  """
  @spec put(Device.t(), attrs()) ::
          {:ok, Entry.t()} | {:error, :full | :gone | :db_unavailable | Ecto.Changeset.t()}
  def put(%Device{id: device_id}, %{sender: sender, payload: payload} = attrs)
      when is_binary(sender) and is_binary(payload) do
    changeset = Entry.changeset(%Entry{}, Map.put(attrs, :device_id, device_id))

    if changeset.valid?, do: Repo.BusyRetry.run(fn -> insert_transaction(changeset) end), else: {:error, changeset}
  end

  @spec insert_transaction(Ecto.Changeset.t()) :: {:ok, Entry.t()} | {:error, :full | :gone | Ecto.Changeset.t()}
  defp insert_transaction(changeset), do: Repo.immediate_transaction(fn -> insert(changeset) end)

  # Inside the transaction: the device is still there, the usage check,
  # then the insert, each refusal a rollback so the transaction answers
  # `{:error, reason}`. The two sums are one scan of the device's queue.
  # The sender share is, for an own copy, every own row of the device
  # (whatever nick it went out under: one share, so a nick change cannot
  # widen the bound) and, for a peer, that peer's non-own rows by folded nick.
  @spec insert(Ecto.Changeset.t()) :: Entry.t()
  defp insert(changeset) do
    entry = Ecto.Changeset.apply_changes(changeset)
    _ = if not Repo.exists?(where(Device, [d], d.id == ^entry.device_id)), do: Repo.rollback(:gone)
    cost = byte_size(entry.payload) + @row_overhead_bytes
    folded = Identifier.canonical_target(entry.sender)

    {total, sender_total} =
      Entry
      |> where([e], e.device_id == ^entry.device_id)
      |> select([e], {
        coalesce(sum(e.bytes + ^@row_overhead_bytes), 0),
        coalesce(
          sum(
            fragment(
              "CASE WHEN ? = ? AND (? OR ? = ?) THEN ? + ? ELSE 0 END",
              e.own,
              type(^entry.own, :boolean),
              type(^entry.own, :boolean),
              Identifier.nick_fold(e.sender),
              ^folded,
              e.bytes,
              ^@row_overhead_bytes
            )
          ),
          0
        )
      })
      |> Repo.one()

    if total + cost > @max_bytes or sender_total + cost > @max_sender_bytes do
      Repo.rollback(:full)
    else
      changeset |> Repo.insert() |> unwrap_or_rollback()
    end
  end

  defp unwrap_or_rollback({:ok, entry}), do: entry
  defp unwrap_or_rollback({:error, changeset}), do: Repo.rollback(changeset)

  @doc """
  The entries waiting for `device` with an id above `after_id`, oldest
  first, at most `page_size/0` of them. A device pages with the last id it
  was given.
  """
  @spec list(Device.t(), non_neg_integer()) :: [Entry.t()]
  def list(%Device{id: device_id}, after_id) when is_integer(after_id) and after_id >= 0 do
    Entry
    |> where([e], e.device_id == ^device_id and e.id > ^after_id)
    |> order_by([e], asc: e.id)
    |> limit(^@page_size)
    |> Repo.all()
  end

  @doc """
  Deletes the entries in `ids` that wait for `device`. An id that is not
  there — already acknowledged, expired, or another device's — is skipped:
  acknowledging is idempotent, and another device's rows are out of reach,
  so one device acknowledging never takes a message from another.
  """
  @spec ack(Device.t(), [pos_integer()]) :: :ok | {:error, :db_unavailable}
  def ack(%Device{id: device_id}, ids) when is_list(ids) do
    query = where(Entry, [e], e.device_id == ^device_id and e.id in ^ids)

    case Repo.BusyRetry.run(fn -> {:ok, Repo.delete_all(query)} end) do
      {:ok, {_, _}} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  @doc """
  Drops every entry queued before `cutoff` for the devices of `subject` on
  `network_id`, and says who sent the messages a device never read: one
  `{sender, did, count}` per person and device (the person case-folded,
  under the spelling they used last), counting only the verbs that carry a
  message. Key material and NACKs are dropped without being counted.

  One transaction: an acknowledgement racing the sweep either lands first
  (the row is not counted) or finds nothing to delete, never both. The
  write lock is taken only when something has expired: every session
  sweeps at start, and a boot must not queue every session behind a lock
  to delete nothing.
  """
  @spec expire(Subject.t(), integer(), DateTime.t()) ::
          {:ok, [{String.t(), String.t(), pos_integer()}]} | {:error, :db_unavailable}
  def expire({_, _} = subject, network_id, %DateTime{} = cutoff) when is_integer(network_id) do
    devices = Device |> Subject.subject_where(subject) |> where([d], d.network_id == ^network_id) |> select([d], d.id)
    expired = where(Entry, [e], e.device_id in subquery(devices) and e.inserted_at < ^cutoff)

    if Repo.exists?(expired), do: Repo.BusyRetry.run(fn -> expire_transaction(expired) end), else: {:ok, []}
  end

  # Nothing inside rolls back, so the transaction can only commit; a raise
  # (a busy lock) propagates to `BusyRetry` as it would anyway.
  @spec expire_transaction(Ecto.Query.t()) :: {:ok, [{String.t(), String.t(), pos_integer()}]}
  defp expire_transaction(expired) do
    {:ok, _} = committed = Repo.immediate_transaction(fn -> delete_expired(expired) end)
    committed
  end

  # Inside the transaction: who sent what to which device, then the delete.
  @spec delete_expired(Ecto.Query.t()) :: [{String.t(), String.t(), pos_integer()}]
  defp delete_expired(expired) do
    rows =
      expired
      |> join(:inner, [e], d in Device, on: d.id == e.device_id)
      |> order_by([e], asc: e.id)
      |> where([e], not e.own)
      |> select([e, d], {e.sender, d.did, e.verb})
      |> Repo.all()

    {_, _} = Repo.delete_all(expired)
    unread_by_sender(rows)
  end

  # One entry per folded sender and device, keeping the last spelling
  # seen; the rows arrive oldest first.
  @spec unread_by_sender([{String.t(), String.t(), Entry.verb()}]) :: [{String.t(), String.t(), pos_integer()}]
  defp unread_by_sender(rows) do
    rows
    |> Enum.filter(fn {_, _, verb} -> message_verb?(verb) end)
    |> Enum.group_by(fn {sender, did, _} -> {Identifier.canonical_target(sender), did} end)
    |> Enum.map(fn {{_, did}, rows} -> {rows |> List.last() |> elem(0), did, length(rows)} end)
  end
end
