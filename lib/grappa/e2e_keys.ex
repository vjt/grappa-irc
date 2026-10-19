defmodule Grappa.E2eKeys do
  @moduledoc """
  The key bundle grappa hosts for a subject on a network, so a peer's
  KEYREQ is answered while no client of the subject is connected (issue
  2430, "Key distribution").

  The client builds and signs one KEYS payload per one-time key, plus one
  for its fallback key, and uploads them. grappa stores them opaque and
  never reads one: it holds no key, and a swapped key would be caught
  anyway by the peer's pin on the identity key that signs them. When a
  peer asks, `Grappa.Session.Server` takes the oldest one-time key and
  deletes it, so each is handed out once; when they run out it hands out
  the fallback key, which stays. The client replenishes when it connects.

  ## Bounds

  At most `max_one_time_keys/0` one-time keys are held (vodozemac's own
  ceiling on the keys an account publishes) and one fallback key; a new
  fallback key replaces the old. Each payload is at most
  `max_payload_bytes/0`. An upload past any bound is refused whole. A
  one-time key already held is skipped rather than stored twice, so a
  client retrying an upload whose answer it lost never has one key handed
  to two peers.

  Known gap: a one-time key handed out between an upload and its retry is
  stored again by the retry. The peer that later gets it opens a session
  the client can no longer decrypt (the key is gone from its account), and
  recovers through NACK and a re-key.

  ## Boundary

  Deps: `Grappa.IRC` (the base64 rule the schema validates),
  `Grappa.Repo`, `Grappa.Subject`. The `belongs_to` references in `Key`
  carry no edge.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Subject],
    exports: [Key]

  import Ecto.Query

  alias Grappa.E2eKeys.Key
  alias Grappa.{Repo, Subject}

  @max_one_time_keys 50

  @typedoc "What a client uploads: one-time key payloads, and a fallback key payload or `nil`."
  @type upload :: %{one_time_keys: [String.t()], fallback: String.t() | nil}

  @typedoc "How much of the bundle is left."
  @type status :: %{one_time_keys: non_neg_integer(), fallback: boolean()}

  @doc "One-time keys one subject's bundle on one network may hold."
  @spec max_one_time_keys() :: 50
  def max_one_time_keys, do: @max_one_time_keys

  @doc "The longest payload a key may carry, in bytes."
  @spec max_payload_bytes() :: 1024
  def max_payload_bytes, do: Key.max_payload_bytes()

  @doc """
  Adds `one_time_keys` to the bundle of `subject` on `network_id`, and
  replaces its fallback key when `fallback` is given. Returns what the
  bundle then holds.

  `{:error, :bad_request}` for an upload with nothing in it or a payload
  that is not base64 or is over `max_payload_bytes/0`; `{:error,
  :too_large}` when the bundle would pass `max_one_time_keys/0`. Either
  way nothing is stored. `{:error, :db_unavailable}` when the write lock
  stays taken past the retry budget.
  """
  @spec upload(Subject.t(), integer(), upload()) ::
          {:ok, status()} | {:error, :bad_request | :too_large | :db_unavailable}
  def upload({_, _} = subject, network_id, %{one_time_keys: otks, fallback: fallback})
      when is_integer(network_id) and is_list(otks) and (is_binary(fallback) or is_nil(fallback)) do
    # A one-time key is one payload: the same one twice is the same key, and
    # handing it to two peers breaks the second one's session.
    otks = Enum.uniq(otks)

    # An upload that could never fit is refused before a changeset is built.
    if length(otks) > @max_one_time_keys do
      {:error, :too_large}
    else
      changesets =
        Enum.map(otks, &changeset(subject, network_id, :otk, &1)) ++
          if(fallback, do: [changeset(subject, network_id, :fallback, fallback)], else: [])

      store_valid(subject, network_id, changesets)
    end
  end

  @spec store_valid(Subject.t(), integer(), [Ecto.Changeset.t()]) ::
          {:ok, status()} | {:error, :bad_request | :too_large | :db_unavailable}
  defp store_valid(_, _, []), do: {:error, :bad_request}

  defp store_valid(subject, network_id, changesets) do
    if Enum.all?(changesets, & &1.valid?),
      do: Repo.BusyRetry.run(fn -> upload_transaction(subject, network_id, changesets) end),
      else: {:error, :bad_request}
  end

  @spec changeset(Subject.t(), integer(), Key.kind(), term()) :: Ecto.Changeset.t()
  defp changeset(subject, network_id, kind, payload) do
    attrs = Subject.put_subject_id(%{network_id: network_id, kind: kind, payload: payload}, subject)
    Key.changeset(%Key{}, attrs)
  end

  # The count check and the inserts are one transaction, so two uploads
  # cannot both squeeze into the last room. A one-time key already held is
  # skipped, not stored twice: a client that never saw the answer to an
  # upload sends the same batch again, and it costs nothing against the
  # bound.
  @spec upload_transaction(Subject.t(), integer(), [Ecto.Changeset.t(), ...]) ::
          {:ok, status()} | {:error, :too_large}
  defp upload_transaction(subject, network_id, changesets) do
    Repo.immediate_transaction(fn ->
      held = subject |> kind(network_id, :otk) |> select([k], k.payload) |> Repo.all() |> MapSet.new()
      new = Enum.reject(changesets, &held_otk?(&1, held))
      adding = Enum.count(new, &(Ecto.Changeset.get_field(&1, :kind) == :otk))

      if MapSet.size(held) + adding > @max_one_time_keys,
        do: Repo.rollback(:too_large),
        else: store(subject, network_id, new)
    end)
  end

  @spec held_otk?(Ecto.Changeset.t(), MapSet.t(String.t())) :: boolean()
  defp held_otk?(changeset, held),
    do:
      Ecto.Changeset.get_field(changeset, :kind) == :otk and
        MapSet.member?(held, Ecto.Changeset.get_field(changeset, :payload))

  # Inside the transaction: a new fallback key replaces the old one.
  @spec store(Subject.t(), integer(), [Ecto.Changeset.t()]) :: status()
  defp store(subject, network_id, changesets) do
    if Enum.any?(changesets, &(Ecto.Changeset.get_field(&1, :kind) == :fallback)),
      do: {_, _} = Repo.delete_all(kind(subject, network_id, :fallback))

    Enum.each(changesets, &Repo.insert!/1)
    status(subject, network_id)
  end

  @doc "How many one-time keys `subject` has left on `network_id`, and whether it has a fallback key."
  @spec status(Subject.t(), integer()) :: status()
  def status({_, _} = subject, network_id) when is_integer(network_id) do
    %{
      one_time_keys: count_otks(subject, network_id),
      fallback: Repo.exists?(kind(subject, network_id, :fallback))
    }
  end

  @doc """
  The key to hand out next. Asked for `:otk`, the oldest one-time key, or
  the fallback key when none is left; asked for `:fallback`, only the
  fallback key. `{:error, :empty}` when there is none.

  Nothing is removed: `consume/1` does that once the caller is sure it
  will send the key.
  """
  @spec next(Subject.t(), integer(), Key.kind()) :: {:ok, Key.t()} | {:error, :empty}
  def next({_, _} = subject, network_id, :otk) when is_integer(network_id) do
    case subject |> kind(network_id, :otk) |> order_by([k], asc: k.id) |> limit(1) |> Repo.one() do
      %Key{} = key -> {:ok, key}
      nil -> next(subject, network_id, :fallback)
    end
  end

  def next({_, _} = subject, network_id, :fallback) when is_integer(network_id) do
    case Repo.one(kind(subject, network_id, :fallback)) do
      %Key{} = key -> {:ok, key}
      nil -> {:error, :empty}
    end
  end

  @doc """
  Marks `key` as handed out: a one-time key is deleted, so it is never
  handed out again; the fallback key stays. `{:error, :gone}` when the key
  is no longer in the bundle — taken already, or dropped by `clear/2` or
  a newer fallback key — so a key picked before the client changed its
  bundle is never sent after.
  """
  #
  # By id alone: ids are never reused (the table is `AUTOINCREMENT`) and a
  # row never changes kind, so the id names the very key that was picked.
  @spec consume(Key.t()) :: :ok | {:error, :gone | :db_unavailable}
  def consume(%Key{kind: :otk, id: id}) do
    case Repo.BusyRetry.run(fn -> {:ok, Repo.delete_all(where(Key, [k], k.id == ^id))} end) do
      {:ok, {1, _}} -> :ok
      {:ok, {0, _}} -> {:error, :gone}
      {:error, :db_unavailable} = err -> err
    end
  end

  def consume(%Key{kind: :fallback, id: id}) do
    if Repo.exists?(where(Key, [k], k.id == ^id)), do: :ok, else: {:error, :gone}
  end

  @doc """
  Drops the whole bundle of `subject` on `network_id`: what a client does
  when it starts over with a new account, so no peer is handed a key of
  the old one.
  """
  @spec clear(Subject.t(), integer()) :: :ok | {:error, :db_unavailable}
  def clear({_, _} = subject, network_id) when is_integer(network_id) do
    query = Key |> Subject.subject_where(subject) |> where([k], k.network_id == ^network_id)

    case Repo.BusyRetry.run(fn -> {:ok, Repo.delete_all(query)} end) do
      {:ok, {_, _}} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  @spec count_otks(Subject.t(), integer()) :: non_neg_integer()
  defp count_otks(subject, network_id), do: Repo.aggregate(kind(subject, network_id, :otk), :count)

  @spec kind(Subject.t(), integer(), Key.kind()) :: Ecto.Query.t()
  defp kind(subject, network_id, kind),
    do: Key |> Subject.subject_where(subject) |> where([k], k.network_id == ^network_id and k.kind == ^kind)
end
