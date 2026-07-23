defmodule Grappa.QueryWindows do
  @moduledoc """
  Per-subject persisted DM (query) windows — the server-side primitive
  that lets cicchetto restore open query windows across page reloads
  and device switches.

  ## Why this exists

  cicchetto derives channel windows from live IRC JOIN state (no
  persistence needed — you're either joined or you're not). DM windows
  have no equivalent server-side signal; the operator just opened a
  `/msg` or clicked a nick. Without this table the window list resets
  to empty on every reload.

  ## What "open" means

  A row in `query_windows` means the subject explicitly opened a DM
  window with `target_nick` on `network_id`. The cicchetto C-buckets
  consume the list via Phoenix Channels snapshot on join; individual
  open/close events are pushed as they happen. This table is NOT a
  conversation record — it's purely a UI-state flag. Scrollback is
  owned by `Grappa.Scrollback`.

  ## Subject-scoped (visitor-parity V1, 2026-05-15)

  Both registered users and visitors may persist query windows;
  storage uses the XOR FK shape (`user_id` XOR `visitor_id`) proven
  by `Grappa.Scrollback.Message` and `Grappa.ReadCursor.Cursor`.
  Visitor reaping CASCADEs the rows on TTL expiry. NickServ-
  identified visitors with infinite TTL keep them indefinitely.

  Every public function takes a `Grappa.Subject.t()` tagged tuple
  rather than a raw `user_id` — the helper enforces the FK column
  invariant at the call site and keeps `lib/grappa/scrollback.ex`,
  `lib/grappa/read_cursor.ex`, this module and the others speaking
  the same shape.

  ## Case-insensitive uniqueness (rfc1459, GH #121)

  IRC nicks are case-insensitive. Azzurra runs bahamut (rfc1459
  casemapping), so besides A-Z it folds `[ ] \\ ~` → `{ } | ^`. Two
  partial unique **expression** indexes — one per subject branch —
  enforce `(<subject_id>, network_id, rfc1459-fold(target_nick))` so
  "FooBar"/"foobar" AND "nick[1]"/"nick{1}" are the same DM target. The
  fold is `Grappa.IRC.Identifier.nick_fold/1` (query side) /
  `canonical_nick/1` (in-memory); the stored `target_nick` column is
  case-preserving (original input wins). The SQL fold expression in the
  index, the `conflict_target/1` upsert fragment, and `nick_fold/1` MUST
  stay character-identical or sqlite stops using the index.

  ## Idempotent open / close

  Both `open/4` and `close/4` are safe to call multiple times with the
  same arguments. `open/4` returns the existing row on a duplicate call
  without updating it ("first opened" semantics — `opened_at` is a
  stable anchor). `close/4` returns `:ok` whether or not a row existed.

  After every successful call to `open/4` or `close/4`, the current
  full window list is broadcast on `Topic.user(subject_label)` as the
  envelope built by `Grappa.QueryWindows.Wire.windows_list_payload/1`:

      Wire.windows_list_payload(Wire.render_grouped(list_for_subject(subject)))

  The payload windows shape is `t:Grappa.QueryWindows.Wire.windows_map/0`
  (snake_case keys, ISO-8601 strings). Pre-CP15 B6 the broadcast carried
  raw `%Window{}` structs which crashed the WS edge during fan-out;
  CP15 B6 added the Wire module + render_grouped/1 sweep, but the
  typespecs declaring the shape weren't updated until CP16 B4. Cic
  consumes the snake_case shape directly via the typed `WireUserEvent`
  query_windows_list arm (`api.ts` `QueryWindowEntry`).

  This lets cicchetto maintain consistent state via a simple `setState`
  rather than tracking individual deltas.

  ## Boundary

  `Grappa.QueryWindows` is a standalone context. Its only deps are:
    * `Grappa.Repo` — persistence.
    * `Grappa.IRC` — `Identifier.nick_fold/1` (rfc1459 DM-target key).
    * `Grappa.Subject` — XOR FK helper.
    * `Grappa.Accounts` (via `User` association — FK reference only).
    * `Grappa.PubSub` — `Topic.user/1` for the `query_windows_list` broadcast.

  Plus two struct-only **dirty xrefs** (schema refs, not real deps — see
  the `use Boundary` note): `Grappa.Networks.Network` and
  `Grappa.Visitors.Visitor`, each a `belongs_to` FK association.

  The `Window` schema module is internal; callers receive `%Window{}`
  structs by type but MUST NOT alias or import the schema module
  directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.PubSub, Grappa.Repo, Grappa.Subject],
    # `Networks.Network` is referenced ONLY as a schema — the
    # `belongs_to :network` association + the FK-existence `Repo.exists?`
    # query in `check_exists/4`. Declared a dirty xref (NOT a real dep),
    # mirroring `Grappa.Scrollback` / `Grappa.ReadCursor`: a real
    # `QueryWindows → Networks` edge would close the cycle
    # `Session → QueryWindows → Networks → Session` once #373 made
    # Session depend on QueryWindows (for `rename/4` on a peer NICK).
    # The struct-only reference carries no behaviour Boundary could gate.
    dirty_xrefs: [Grappa.Networks.Network, Grappa.Visitors.Visitor],
    exports: [Window, Wire]

  import Ecto.Query

  alias Grappa.{
    Accounts.User,
    IRC.Identifier,
    Networks.Network,
    PubSub.Topic,
    QueryWindows.Window,
    QueryWindows.Wire,
    Repo,
    Subject,
    Visitors.Visitor
  }

  # Identifier.nick_fold/1 is a query macro (rfc1459 fold fragment).
  require Identifier

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @typedoc """
  Wire shape of a single `query_windows_list` event payload — the full current
  window list for the subject, keyed by `network_id`. Carries the
  `t:Grappa.QueryWindows.Wire.windows_map/0` snake_case projection
  (NOT raw `%Window{}` structs — those crashed the WS edge fastlane
  pre-CP15 B6). Alias for `t:Grappa.QueryWindows.Wire.windows_list_payload/0`
  so downstream callers (channel typedoc, REST docs) can refer to the
  envelope without reaching into the wire module.
  """
  @type windows_list_payload :: Wire.windows_list_payload()

  @doc """
  Idempotently opens a DM window for `target_nick` on `(subject, network_id)`.

  If a row for the same `(subject, network_id, rfc1459-fold(target_nick))`
  already exists, returns `{:ok, existing_row}` WITHOUT modifying the
  existing row (`opened_at` is left unchanged — first-opened
  semantics). If no row exists, inserts one with `opened_at =
  DateTime.utc_now()`.

  After the DB mutation (whether new insert or idempotent re-select),
  broadcasts the full current window list on
  `Topic.user(subject_label)` so connected cicchetto clients can
  update their state. `subject_label` is the user-rooted topic
  string (`<user_name>` or `visitor:<uuid>`).

  The implementation uses `Repo.insert/2` with `on_conflict: :nothing`
  so concurrent callers race on the per-subject unique index — the
  loser finds the row via a follow-up select that folds (rfc1459) to
  match case-insensitively. Race safety: at most two DB round-trips
  per contended open.
  """
  @spec open(Subject.t(), integer(), String.t(), String.t()) ::
          {:ok, Window.t()} | {:error, Ecto.Changeset.t()}
  def open({_, _} = subject, network_id, target_nick, subject_label)
      when is_integer(network_id) and is_binary(target_nick) and is_binary(subject_label) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    attrs =
      Subject.put_subject_id(
        %{network_id: network_id, target_nick: target_nick, opened_at: now},
        subject
      )

    cs =
      %Window{}
      |> Window.changeset(attrs)
      |> validate_subject_exists(subject)

    result =
      if cs.valid? do
        do_insert(cs, subject, network_id, target_nick)
      else
        {:error, cs}
      end

    case result do
      {:ok, _} = ok ->
        broadcast_windows_list(subject, subject_label)
        ok

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Closes (deletes) the DM window for `target_nick` on
  `(subject, network_id)`.

  Case-insensitive: `close(s, n, "FooBar", label)` deletes a "foobar"
  window. Returns `:ok` whether or not a row was deleted (idempotent).

  After the DB delete, broadcasts the full current window list on
  `Topic.user(subject_label)` so connected cicchetto clients can
  update their state.
  """
  @spec close(Subject.t(), integer(), String.t(), String.t()) :: :ok
  def close({_, _} = subject, network_id, target_nick, subject_label)
      when is_integer(network_id) and is_binary(target_nick) and is_binary(subject_label) do
    folded = Identifier.canonical_nick(target_nick)

    Window
    |> Subject.subject_where(subject)
    |> where([w], w.network_id == ^network_id)
    |> where([w], Identifier.nick_fold(w.target_nick) == ^folded)
    |> Repo.delete_all()

    broadcast_windows_list(subject, subject_label)
    :ok
  end

  @doc """
  Renames the DM (query) window for `old_nick` to `new_nick` on
  `(subject, network_id)` — the server-authoritative half of #373 (a
  query window following a peer's NICK change).

  Case-insensitive on `old_nick` (rfc1459 fold, #121). Returns:

    * `{:ok, :noop}` when `old_nick` and `new_nick` fold to the SAME
      identity (a case-only change — the fold-keyed row already resolves
      to `new_nick`, and IRC nick routing is case-insensitive, so nothing
      moves; #372 covers the display dedup), OR when no window folds to
      `old_nick` (a peer we never queried renamed — nothing to follow).
    * `{:ok, :renamed}` when a window folding to `old_nick` moved to
      `new_nick`. If a window folding to `new_nick` ALREADY exists
      (nick-collision), the `old_nick` row is DELETED and the existing
      `new_nick` row kept — the two DM histories coalesce under one
      window on the read path (`Scrollback.channel_or_dm_where/3`
      aggregates every row folding to the peer; #372 fold-dedup). The
      caller migrates the scrollback rows old -> new via
      `Scrollback.rename_dm_peer/4` on this result.

  Does NOT broadcast: on `:renamed` the caller
  (`Session.Server.apply_effects/2`) migrates the DM scrollback + read
  cursor and THEN calls `broadcast_windows_list/2`, so the
  `query_windows_list` event is a truthful "rename fully applied"
  barrier rather than firing mid-migration (a `:noop` changed nothing,
  so the caller broadcasts nothing).
  """
  @spec rename(Subject.t(), integer(), String.t(), String.t()) ::
          {:ok, :renamed | :noop}
  def rename({_, _} = subject, network_id, old_nick, new_nick)
      when is_integer(network_id) and is_binary(old_nick) and is_binary(new_nick) do
    folded_old = Identifier.canonical_nick(old_nick)
    folded_new = Identifier.canonical_nick(new_nick)

    if folded_old == folded_new do
      {:ok, :noop}
    else
      do_rename(subject, network_id, folded_old, folded_new, new_nick)
    end
  end

  @spec do_rename(Subject.t(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, :renamed | :noop}
  defp do_rename(subject, network_id, folded_old, folded_new, new_nick) do
    old_query =
      Window
      |> Subject.subject_where(subject)
      |> where([w], w.network_id == ^network_id)
      |> where([w], Identifier.nick_fold(w.target_nick) == ^folded_old)

    if Repo.exists?(old_query) do
      if new_window_exists?(subject, network_id, folded_new) do
        # Nick-collision merge: the target identity already has a window.
        # Drop the old row; the read path coalesces both DM histories
        # under the survivor (no row duplication — distinct message rows
        # simply aggregate to one folded key).
        Repo.delete_all(old_query)
      else
        # This rename runs in the (per-subject-serialized) Session.Server,
        # but `open/4` runs in the Phoenix channel process, so a concurrent
        # `open(new_nick)` CAN race a row into `folded_new` between the
        # check above and this update — the fold unique index would then
        # reject the UPDATE (and `update_all` has no changeset to attach a
        # `unique_constraint/2` to, so it raises rather than returns an
        # error). Rescue that race and degrade to the merge path: the
        # target identity now has a window, so drop the old row.
        try do
          Repo.update_all(old_query, set: [target_nick: new_nick])
        rescue
          Ecto.ConstraintError -> Repo.delete_all(old_query)
        end
      end

      # NB: no broadcast here — the caller broadcasts AFTER migrating the
      # DM scrollback + read cursor, so the `query_windows_list` event is
      # a truthful "rename fully applied" barrier (#373 rename-order fix).
      {:ok, :renamed}
    else
      {:ok, :noop}
    end
  end

  @spec new_window_exists?(Subject.t(), integer(), String.t()) :: boolean()
  defp new_window_exists?(subject, network_id, folded_new) do
    Window
    |> Subject.subject_where(subject)
    |> where([w], w.network_id == ^network_id)
    |> where([w], Identifier.nick_fold(w.target_nick) == ^folded_new)
    |> Repo.exists?()
  end

  @doc """
  Returns all open DM windows for `subject`, grouped by `network_id`.

  The map keys are integer `network_id`s; values are lists of `%Window{}`
  structs ordered by `opened_at ASC` (oldest-opened first — natural
  display order). When two windows share the same `opened_at` second, `id
  ASC` is the tiebreaker.

  Returns `%{}` when the subject has no open windows.
  """
  @spec list_for_subject(Subject.t()) :: %{integer() => [Window.t()]}
  def list_for_subject({_, _} = subject) do
    Window
    |> Subject.subject_where(subject)
    |> order_by([w], asc: w.opened_at, asc: w.id)
    |> Repo.all()
    |> Enum.group_by(& &1.network_id)
  end

  @doc """
  Test-support: drains every `query_windows` row for `user_id` in a
  single DELETE. Intended for `Grappa.TestSupport.SubjectReset` only —
  production lifecycle uses `open/4` + `close/4` per (subject, network,
  target_nick).
  """
  @spec close_all_for_user(Ecto.UUID.t()) :: :ok
  def close_all_for_user(user_id) when is_binary(user_id) do
    query = from(w in Window, where: w.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec do_insert(Ecto.Changeset.t(), Subject.t(), integer(), String.t()) ::
          {:ok, Window.t()} | {:error, Ecto.Changeset.t()}
  defp do_insert(cs, subject, network_id, target_nick) do
    case Repo.insert(cs,
           on_conflict: :nothing,
           conflict_target: conflict_target(subject)
         ) do
      {:ok, %Window{id: nil}} ->
        # on_conflict: :nothing returns a struct with id=nil on conflict.
        # Re-select the existing row case-insensitively.
        fetch_existing(subject, network_id, target_nick)

      {:ok, window} ->
        {:ok, window}

      {:error, %Ecto.Changeset{} = failed_cs} ->
        {:error, failed_cs}
    end
  end

  # The partial unique indexes carry the `WHERE <subject>_id IS NOT
  # NULL` predicate; sqlite requires the conflict_target fragment to
  # mirror it for the upsert to recognize the index. One fragment per
  # subject branch. The rfc1459 fold expression (#121) is derived from
  # the single source `Identifier.nick_fold_sql/1` (#364 E/S2 — was a
  # hand-copied literal, unpinned by the fold-drift test); it MUST stay
  # character-identical to the folded index in
  # `FoldQueryWindowsTargetNickRfc1459` and to `Identifier.nick_fold/1`,
  # or sqlite won't match the conflict target to the index.
  @nick_fold_sql Grappa.IRC.Identifier.nick_fold_sql("target_nick")

  defp conflict_target({:user, _}),
    do: {:unsafe_fragment, "(user_id, network_id, #{@nick_fold_sql}) WHERE user_id IS NOT NULL"}

  defp conflict_target({:visitor, _}),
    do: {:unsafe_fragment, "(visitor_id, network_id, #{@nick_fold_sql}) WHERE visitor_id IS NOT NULL"}

  # Pre-flight FK existence check — converts a missing user / visitor /
  # network into a clean changeset error before `Repo.insert` raises
  # `Ecto.ConstraintError`. ecto_sqlite3 returns FK constraint names as
  # `nil`, so `assoc_constraint/2` alone can't surface them. Same shape
  # as `Grappa.UserSettings.validate_subject_exists/2` (V1) and the
  # original M6 fix at this site (2026-05-08).
  @spec validate_subject_exists(Ecto.Changeset.t(), Subject.t()) :: Ecto.Changeset.t()
  defp validate_subject_exists(changeset, subject) do
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

  @doc """
  Broadcasts the full current window list for `subject` on
  `Topic.user(subject_label)` as a `query_windows_list` event.

  Public because `rename/4` deliberately does NOT broadcast (#373): the
  caller (`Session.Server.apply_effects/2`) must migrate the DM
  scrollback + read cursor FIRST, then call this — so the broadcast is a
  truthful "the rename is fully applied" barrier. If `rename/4`
  broadcast internally (as `open/4` / `close/4` do, which have no
  follow-on migration), a client reacting to the event could read the
  DM history before its rows moved old -> new. `open/4` / `close/4` call
  the same helper inline since they have nothing to order it against.
  """
  @spec broadcast_windows_list(Subject.t(), String.t()) :: :ok
  def broadcast_windows_list(subject, subject_label) do
    payload =
      subject
      |> list_for_subject()
      |> Wire.render_grouped()
      |> Wire.windows_list_payload()

    :ok = Grappa.PubSub.broadcast_event(Topic.user(subject_label), payload)
  end

  @spec fetch_existing(Subject.t(), integer(), String.t()) ::
          {:ok, Window.t()} | {:error, Ecto.Changeset.t()}
  defp fetch_existing(subject, network_id, target_nick) do
    folded = Identifier.canonical_nick(target_nick)

    query =
      Window
      |> Subject.subject_where(subject)
      |> where([w], w.network_id == ^network_id)
      |> where([w], Identifier.nick_fold(w.target_nick) == ^folded)

    case Repo.one(query) do
      %Window{} = window ->
        {:ok, window}

      nil ->
        # Should not happen: on_conflict: :nothing means a row was there at
        # insert time; it couldn't have been deleted in the tiny window
        # between conflict detection and our re-select in normal operation.
        # If it did (manual delete, cascading FK drop), re-try once via
        # returning a validation-error changeset shape that the caller can
        # surface. This path is effectively unreachable in production.
        attrs =
          Subject.put_subject_id(
            %{network_id: network_id, target_nick: target_nick, opened_at: DateTime.utc_now()},
            subject
          )

        {:error, Window.changeset(%Window{}, attrs)}
    end
  end
end
