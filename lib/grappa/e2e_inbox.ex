defmodule Grappa.E2eInbox do
  @moduledoc """
  The offline queue for end-to-end encrypted queries (issue 2430).

  A peer's whole message — reassembled from its IRC lines by
  `Grappa.Session.Server`, still ciphertext — is put here, and the session
  then pushes it to the subject's clients with its `id`. A client that has
  read it acknowledges the id and the row is deleted. A client that was
  not connected fetches what is waiting when it connects. Delivery is
  therefore at least once: a client that read a message but whose
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
  of tiny messages is bounded too. A subject's queue on one network holds
  at most `max_bytes/0`, and one sender (case-folded) at most
  `max_sender_bytes/0` of it, so one peer cannot fill the queue against
  everybody else. Past either bound `put/3` refuses with `{:error, :full}`.

  A row older than `ttl_seconds/0` is dropped by `expire/3`, which the
  session runs; the session then tells the recipient — and only the
  recipient — who sent messages that were never read.

  ## Boundary

  Deps: `Grappa.IRC` (the nick fold and the E2E wire rules the schema
  validates), `Grappa.Repo`, `Grappa.Subject`. The `belongs_to` references
  in `Entry` carry no edge.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Subject],
    exports: [Entry]

  import Ecto.Query

  alias Grappa.E2eInbox.Entry
  alias Grappa.IRC.Identifier
  alias Grappa.{Repo, Subject}

  require Identifier

  @max_bytes 4 * 1024 * 1024
  @max_sender_bytes 1024 * 1024
  @row_overhead_bytes 256
  @page_size 100
  @ttl_seconds 7 * 24 * 60 * 60

  # The two verbs that carry something a person wrote. Key material and
  # NACKs expire too, but nobody is told about them: they are the protocol
  # talking to itself.
  @message_verbs [:pkmsg, :msg]

  @typedoc "What `put/3` stores: one whole message, as the session reassembled it."
  @type attrs :: %{sender: String.t(), verb: Entry.verb(), msgid: String.t(), payload: String.t()}

  @doc "Bytes one subject's queue on one network may hold, overhead included."
  @spec max_bytes() :: pos_integer()
  def max_bytes, do: @max_bytes

  @doc "The share of `max_bytes/0` one sender may hold."
  @spec max_sender_bytes() :: pos_integer()
  def max_sender_bytes, do: @max_sender_bytes

  @doc "What each row costs against the bounds on top of its payload."
  @spec row_overhead_bytes() :: pos_integer()
  def row_overhead_bytes, do: @row_overhead_bytes

  @doc "The most entries `list/3` returns at once."
  @spec page_size() :: pos_integer()
  def page_size, do: @page_size

  @doc "How long a message waits for a client before it is dropped."
  @spec ttl_seconds() :: pos_integer()
  def ttl_seconds, do: @ttl_seconds

  @doc """
  Queues one whole message for `subject` on `network_id`.

  `{:error, :full}` when the row would take the subject's queue past
  `max_bytes/0`, or the sender's share past `max_sender_bytes/0`; the
  check and the insert are one transaction, so two arrivals cannot both
  squeeze into the last room. `{:error, :db_unavailable}` when the write
  lock stays taken past the retry budget.
  """
  @spec put(Subject.t(), integer(), attrs()) ::
          {:ok, Entry.t()} | {:error, :full | :db_unavailable | Ecto.Changeset.t()}
  def put({_, _} = subject, network_id, %{sender: sender, payload: payload} = attrs)
      when is_integer(network_id) and is_binary(sender) and is_binary(payload) do
    changeset =
      Entry.changeset(%Entry{}, attrs |> Map.put(:network_id, network_id) |> Subject.put_subject_id(subject))

    if changeset.valid?, do: Repo.BusyRetry.run(fn -> insert_transaction(changeset) end), else: {:error, changeset}
  end

  @spec insert_transaction(Ecto.Changeset.t()) :: {:ok, Entry.t()} | {:error, :full | Ecto.Changeset.t()}
  defp insert_transaction(changeset), do: Repo.immediate_transaction(fn -> insert(changeset) end)

  # Inside the transaction: the usage check, then the insert, each refusal
  # a rollback so the transaction answers `{:error, reason}`. The two sums
  # are one scan of the partition.
  @spec insert(Ecto.Changeset.t()) :: Entry.t()
  defp insert(changeset) do
    entry = Ecto.Changeset.apply_changes(changeset)
    cost = byte_size(entry.payload) + @row_overhead_bytes
    folded = Identifier.canonical_target(entry.sender)

    {total, sender_total} =
      Entry
      |> partition(entry)
      |> select([e], {
        coalesce(sum(fragment("length(?) + ?", e.payload, ^@row_overhead_bytes)), 0),
        coalesce(
          sum(
            fragment(
              "CASE WHEN ? = ? THEN length(?) + ? ELSE 0 END",
              Identifier.nick_fold(e.sender),
              ^folded,
              e.payload,
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
  The entries waiting for `subject` on `network_id` with an id above
  `after_id`, oldest first, at most `page_size/0` of them. A client pages
  with the last id it was given.
  """
  @spec list(Subject.t(), integer(), non_neg_integer()) :: [Entry.t()]
  def list({_, _} = subject, network_id, after_id)
      when is_integer(network_id) and is_integer(after_id) and after_id >= 0 do
    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id and e.id > ^after_id)
    |> order_by([e], asc: e.id)
    |> limit(^@page_size)
    |> Repo.all()
  end

  @doc """
  Deletes the entries in `ids` that belong to `subject` on `network_id`.
  An id that is not there — already acknowledged, expired, or someone
  else's — is skipped: acknowledging is idempotent, and another subject's
  rows are out of reach.
  """
  @spec ack(Subject.t(), integer(), [pos_integer()]) :: :ok | {:error, :db_unavailable}
  def ack({_, _} = subject, network_id, ids) when is_integer(network_id) and is_list(ids) do
    query =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id and e.id in ^ids)

    case Repo.BusyRetry.run(fn -> {:ok, Repo.delete_all(query)} end) do
      {:ok, {_, _}} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  @doc """
  Drops every entry of `subject` on `network_id` queued before `cutoff`,
  and says who sent the messages that were never read: one
  `{sender, count}` per person (case-folded, under the spelling they used
  last), counting only the verbs that carry a message. Key material and
  NACKs are dropped without being counted.

  One transaction: an acknowledgement racing the sweep either lands first
  (the row is not counted) or finds nothing to delete, never both.
  """
  @spec expire(Subject.t(), integer(), DateTime.t()) ::
          {:ok, [{String.t(), pos_integer()}]} | {:error, :db_unavailable}
  def expire({_, _} = subject, network_id, %DateTime{} = cutoff) when is_integer(network_id) do
    expired =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id and e.inserted_at < ^cutoff)

    Repo.BusyRetry.run(fn ->
      Repo.immediate_transaction(fn ->
        rows = expired |> order_by([e], asc: e.id) |> select([e], {e.sender, e.verb}) |> Repo.all()
        {_, _} = Repo.delete_all(expired)
        unread_by_sender(rows)
      end)
    end)
  end

  # One entry per folded sender, keeping the last spelling seen; the rows
  # arrive oldest first.
  @spec unread_by_sender([{String.t(), Entry.verb()}]) :: [{String.t(), pos_integer()}]
  defp unread_by_sender(rows) do
    rows
    |> Enum.filter(fn {_, verb} -> verb in @message_verbs end)
    |> Enum.group_by(fn {sender, _} -> Identifier.canonical_target(sender) end, fn {sender, _} -> sender end)
    |> Enum.map(fn {_, senders} -> {List.last(senders), length(senders)} end)
  end

  @spec partition(Ecto.Queryable.t(), Entry.t()) :: Ecto.Query.t()
  defp partition(queryable, %Entry{user_id: user_id, visitor_id: nil, network_id: network_id}),
    do: queryable |> Subject.subject_where({:user, user_id}) |> where([e], e.network_id == ^network_id)

  defp partition(queryable, %Entry{user_id: nil, visitor_id: visitor_id, network_id: network_id}),
    do: queryable |> Subject.subject_where({:visitor, visitor_id}) |> where([e], e.network_id == ^network_id)
end
