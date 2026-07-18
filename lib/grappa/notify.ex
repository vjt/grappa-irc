defmodule Grappa.Notify do
  @moduledoc """
  Per-subject, per-network presence watch list — the server-side
  primitive behind `/notify` (GH #247).

  ## Why this exists

  `/notify` looks like a thin wrapper over upstream MONITOR/WATCH, but
  those registrations live on the *upstream connection* and die with
  it. grappa is a persistent bouncer: the watch list must survive both
  the client's own disconnect and any upstream reconnect, and be
  re-armed automatically after every registration. So the list is
  DB-owned here; `Grappa.Session.Server` loads it at 001 RPL_WELCOME
  and arms the upstream mechanism (MONITOR where advertised, WATCH
  otherwise). Presence STATE (online/offline) is session-owned and
  never persisted — this table is only the durable list.

  ## Subject-scoped

  Both registered users and visitors may keep watch lists; storage
  uses the XOR FK shape (`user_id` XOR `visitor_id`) proven by
  `Grappa.QueryWindows` / `Grappa.ReadCursor.Cursor`. Visitor reaping
  CASCADEs the rows on TTL expiry.

  ## Case-insensitive uniqueness (rfc1459, GH #121)

  Two partial unique **expression** indexes — one per subject branch —
  enforce `(<subject_id>, network_id, rfc1459-fold(nick))` so
  "FooBar"/"foobar" AND "nick[1]"/"nick{1}" are one watch entry. The
  fold is `Grappa.IRC.Identifier.nick_fold/1` (query side) /
  `canonical_nick/1` (in-memory); the stored `nick` column is
  case-preserving (first add wins). The SQL fold expression in the
  index, the `conflict_target/1` upsert fragment, and `nick_fold/1`
  MUST stay character-identical or sqlite stops using the index.

  ## Atomic batch add, idempotent everything

  `add/4` takes a nick LIST (the `/notify add a b c` shape) and is
  atomic: any invalid nick rejects the whole batch with no partial
  insert. Per-nick duplicates are idempotent no-ops returning the
  existing row. `remove/4` and `clear/3` return `:ok` whether or not
  rows existed.

  After every successful mutation the current full list is broadcast
  on `Topic.user(subject_label)` as the envelope built by
  `Grappa.Notify.Wire.notify_list_payload/1` — same
  full-list-snapshot contract as `Grappa.QueryWindows`, so cicchetto
  maintains state via a simple `setState` rather than deltas.

  ## Boundary

  Standalone context. Deps mirror `Grappa.QueryWindows`:
    * `Grappa.Repo` — persistence.
    * `Grappa.IRC` — `Identifier.nick_fold/1` + `canonical_nick/1`.
    * `Grappa.Subject` — XOR FK helper.
    * `Grappa.Accounts` / `Grappa.Networks` — FK references.
    * `Grappa.PubSub` — `Topic.user/1` for the `notify_list` broadcast.

  The `Entry` schema module is internal; callers receive `%Entry{}`
  structs by type but MUST NOT alias or import the schema directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.PubSub, Grappa.Repo, Grappa.Subject],
    # Networks.Network is an FK-reference-only xref (belongs_to + the
    # existence pre-check), NOT a full dep: a `deps:` edge would close
    # the cycle Session -> Notify -> Networks -> LiveIntrospection ->
    # Session (Session reads the notify list at the end-of-MOTD arm).
    # Same treatment as Visitors.Visitor here and in QueryWindows.
    dirty_xrefs: [Grappa.Networks.Network, Grappa.Visitors.Visitor],
    exports: [Entry, Wire]

  import Ecto.Query

  alias Grappa.{
    Accounts.User,
    IRC.Identifier,
    Networks.Network,
    Notify.Entry,
    Notify.Wire,
    PubSub.Topic,
    Repo,
    Subject,
    Visitors.Visitor
  }

  # Identifier.nick_fold/1 is a query macro (rfc1459 fold fragment).
  require Identifier

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Atomically adds `nicks` to the watch list for `(subject, network_id)`.

  Returns `{:ok, entries}` in input order — existing rows for
  duplicate/fold-equal nicks, freshly inserted rows otherwise. Any
  invalid nick (or missing subject/network FK) rejects the WHOLE batch
  with `{:error, changeset}` and no partial insert (transaction).

  After a successful batch, broadcasts the full current list on
  `Topic.user(subject_label)` (`notify_list` envelope).
  """
  @spec add(Subject.t(), integer(), [String.t()], String.t()) ::
          {:ok, [Entry.t()]} | {:error, Ecto.Changeset.t()}
  def add({_, _} = subject, network_id, nicks, subject_label)
      when is_integer(network_id) and is_list(nicks) and nicks != [] and
             is_binary(subject_label) do
    changesets = Enum.map(nicks, &build_changeset(subject, network_id, &1))

    result =
      case Enum.find(changesets, &(not &1.valid?)) do
        nil -> insert_batch(changesets, subject, network_id, nicks)
        invalid_cs -> {:error, invalid_cs}
      end

    case result do
      {:ok, _} = ok ->
        broadcast_notify_list(subject, subject_label)
        ok

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Removes `nicks` (fold-matched, rfc1459) from the watch list for
  `(subject, network_id)`. Idempotent — returns `:ok` whether or not
  any row was deleted. Broadcasts the full current list afterwards.
  """
  @spec remove(Subject.t(), integer(), [String.t()], String.t()) :: :ok
  def remove({_, _} = subject, network_id, nicks, subject_label)
      when is_integer(network_id) and is_list(nicks) and nicks != [] and
             is_binary(subject_label) do
    folded = Enum.map(nicks, &Identifier.canonical_nick/1)

    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> where([e], Identifier.nick_fold(e.nick) in ^folded)
    |> Repo.delete_all()

    broadcast_notify_list(subject, subject_label)
    :ok
  end

  @doc """
  Wipes the watch list for `(subject, network_id)`. Idempotent.
  Broadcasts the full current list afterwards.
  """
  @spec clear(Subject.t(), integer(), String.t()) :: :ok
  def clear({_, _} = subject, network_id, subject_label)
      when is_integer(network_id) and is_binary(subject_label) do
    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> Repo.delete_all()

    broadcast_notify_list(subject, subject_label)
    :ok
  end

  @doc """
  Returns the watch list for `(subject, network_id)` in insertion
  order (`id ASC`). Empty list when none. This is the session-side
  re-arm read at 001 RPL_WELCOME.
  """
  @spec list(Subject.t(), integer()) :: [Entry.t()]
  def list({_, _} = subject, network_id) when is_integer(network_id) do
    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> order_by([e], asc: e.id)
    |> Repo.all()
  end

  @doc """
  Returns all watch entries for `subject`, grouped by `network_id`
  (insertion order within each network). `%{}` when the subject has no
  entries. This is the snapshot-on-attach read.
  """
  @spec list_for_subject(Subject.t()) :: %{integer() => [Entry.t()]}
  def list_for_subject({_, _} = subject) do
    Entry
    |> Subject.subject_where(subject)
    |> order_by([e], asc: e.id)
    |> Repo.all()
    |> Enum.group_by(& &1.network_id)
  end

  @doc """
  Test-support: drains every `notify_entries` row for `user_id` in a
  single DELETE. Intended for `Grappa.TestSupport.SubjectReset` only —
  production lifecycle uses `add/4` / `remove/4` / `clear/3`.
  """
  @spec clear_all_for_user(Ecto.UUID.t()) :: :ok
  def clear_all_for_user(user_id) when is_binary(user_id) do
    query = from(e in Entry, where: e.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec build_changeset(Subject.t(), integer(), String.t()) :: Ecto.Changeset.t()
  defp build_changeset(subject, network_id, nick) do
    attrs = Subject.put_subject_id(%{network_id: network_id, nick: nick}, subject)

    %Entry{}
    |> Entry.changeset(attrs)
    |> validate_refs_exist(subject)
  end

  # Insert the whole batch in one transaction so an FK failure on nick
  # N can't leave nicks 1..N-1 behind. Collect-or-bail via recursive
  # traversal (CLAUDE.md shape); each nick upserts with
  # `on_conflict: :nothing` and re-selects on conflict (idempotent add).
  @spec insert_batch([Ecto.Changeset.t()], Subject.t(), integer(), [String.t()]) ::
          {:ok, [Entry.t()]} | {:error, Ecto.Changeset.t()}
  defp insert_batch(changesets, subject, network_id, nicks) do
    Repo.transaction(fn ->
      case traverse_inserts(Enum.zip(changesets, nicks), [], subject, network_id) do
        {:ok, entries} -> entries
        {:error, cs} -> Repo.rollback(cs)
      end
    end)
  end

  @spec traverse_inserts(
          [{Ecto.Changeset.t(), String.t()}],
          [Entry.t()],
          Subject.t(),
          integer()
        ) :: {:ok, [Entry.t()]} | {:error, Ecto.Changeset.t()}
  defp traverse_inserts([], acc, _, _), do: {:ok, Enum.reverse(acc)}

  defp traverse_inserts([{cs, nick} | rest], acc, subject, network_id) do
    case insert_one(cs, subject, network_id, nick) do
      {:ok, entry} -> traverse_inserts(rest, [entry | acc], subject, network_id)
      {:error, _} = err -> err
    end
  end

  @spec insert_one(Ecto.Changeset.t(), Subject.t(), integer(), String.t()) ::
          {:ok, Entry.t()} | {:error, Ecto.Changeset.t()}
  defp insert_one(cs, subject, network_id, nick) do
    case Repo.insert(cs, on_conflict: :nothing, conflict_target: conflict_target(subject)) do
      {:ok, %Entry{id: nil}} ->
        # on_conflict: :nothing returns a struct with id=nil on conflict.
        # Re-select the existing row case-insensitively (idempotent add;
        # covers both a pre-existing row and a fold-equal earlier nick
        # in this same batch).
        fetch_existing(subject, network_id, nick)

      {:ok, entry} ->
        {:ok, entry}

      {:error, %Ecto.Changeset{} = failed_cs} ->
        {:error, failed_cs}
    end
  end

  # The partial unique indexes carry the `WHERE <subject>_id IS NOT
  # NULL` predicate; sqlite requires the conflict_target fragment to
  # mirror it. The rfc1459 fold expression (#121) MUST stay
  # character-identical to the folded index in `CreateNotifyEntries`
  # and to `Identifier.nick_fold/1`.
  @nick_fold_sql "replace(replace(replace(replace(lower(nick), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"

  defp conflict_target({:user, _}),
    do: {:unsafe_fragment, "(user_id, network_id, #{@nick_fold_sql}) WHERE user_id IS NOT NULL"}

  defp conflict_target({:visitor, _}),
    do: {:unsafe_fragment, "(visitor_id, network_id, #{@nick_fold_sql}) WHERE visitor_id IS NOT NULL"}

  @spec fetch_existing(Subject.t(), integer(), String.t()) ::
          {:ok, Entry.t()} | {:error, Ecto.Changeset.t()}
  defp fetch_existing(subject, network_id, nick) do
    folded = Identifier.canonical_nick(nick)

    query =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id)
      |> where([e], Identifier.nick_fold(e.nick) == ^folded)

    case Repo.one(query) do
      %Entry{} = entry ->
        {:ok, entry}

      nil ->
        # Effectively unreachable: on_conflict: :nothing means a row was
        # there at insert time. Surface as a changeset error the caller
        # can render rather than crash — same shape as QueryWindows.
        attrs = Subject.put_subject_id(%{network_id: network_id, nick: nick}, subject)
        {:error, Entry.changeset(%Entry{}, attrs)}
    end
  end

  # Pre-flight FK existence check — converts a missing user / visitor /
  # network into a clean changeset error before `Repo.insert` raises
  # `Ecto.ConstraintError` (ecto_sqlite3 returns FK constraint names as
  # `nil`, so `assoc_constraint/2` alone can't surface them). Same shape
  # as `Grappa.QueryWindows.validate_subject_exists/2`.
  @spec validate_refs_exist(Ecto.Changeset.t(), Subject.t()) :: Ecto.Changeset.t()
  defp validate_refs_exist(changeset, subject) do
    changeset
    |> check_subject_exists(subject)
    |> check_exists(:network_id, Network, :network)
  end

  defp check_subject_exists(changeset, {:user, _}),
    do: check_exists(changeset, :user_id, User, :user)

  defp check_subject_exists(changeset, {:visitor, _}),
    do: check_exists(changeset, :visitor_id, Visitor, :visitor)

  @spec check_exists(Ecto.Changeset.t(), atom(), module(), atom()) :: Ecto.Changeset.t()
  defp check_exists(changeset, source_field, schema, error_field) do
    case Ecto.Changeset.get_change(changeset, source_field) do
      nil ->
        changeset

      id ->
        query = from(row in schema, where: row.id == ^id)

        if Repo.exists?(query) do
          changeset
        else
          Ecto.Changeset.add_error(changeset, error_field, "does not exist")
        end
    end
  end

  @spec broadcast_notify_list(Subject.t(), String.t()) :: :ok
  defp broadcast_notify_list(subject, subject_label) do
    payload =
      subject
      |> list_for_subject()
      |> Wire.render_grouped()
      |> Wire.notify_list_payload()

    :ok = Grappa.PubSub.broadcast_event(Topic.user(subject_label), payload)
  end
end
