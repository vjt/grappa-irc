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

  ## Case-insensitive uniqueness

  IRC nicks are case-insensitive (RFC 2812 §2.2). Two partial unique
  indexes — one per subject branch — enforce
  `(<subject_id>, network_id, lower(target_nick))` so "FooBar" and
  "foobar" are treated as the same DM target. The stored
  `target_nick` column is case-preserving (original input wins).

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
    * `Grappa.Subject` — XOR FK helper.
    * `Grappa.Accounts` (via `User` association — FK reference only).
    * `Grappa.Networks` (via `Network` association — FK reference only).
    * `Grappa.Visitors` (via `Visitor` association — FK reference only).
    * `Grappa.PubSub` — `Topic.user/1` for the `query_windows_list` broadcast.

  The `Window` schema module is internal; callers receive `%Window{}`
  structs by type but MUST NOT alias or import the schema module
  directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.PubSub, Grappa.Repo, Grappa.Subject],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Window, Wire]

  import Ecto.Query

  alias Grappa.{
    Accounts.User,
    Networks.Network,
    PubSub.Topic,
    QueryWindows.Window,
    QueryWindows.Wire,
    Repo,
    Subject,
    Visitors.Visitor
  }

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

  If a row for the same `(subject, network_id, lower(target_nick))`
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
  loser finds the row via a follow-up `get_by` that uses `lower()` to
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
    lower_nick = String.downcase(target_nick)

    Window
    |> Subject.subject_where(subject)
    |> where([w], w.network_id == ^network_id)
    |> where([w], fragment("lower(?)", w.target_nick) == ^lower_nick)
    |> Repo.delete_all()

    broadcast_windows_list(subject, subject_label)
    :ok
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
  # subject branch.
  defp conflict_target({:user, _}),
    do: {:unsafe_fragment, "(user_id, network_id, lower(target_nick)) WHERE user_id IS NOT NULL"}

  defp conflict_target({:visitor, _}),
    do: {:unsafe_fragment, "(visitor_id, network_id, lower(target_nick)) WHERE visitor_id IS NOT NULL"}

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

  @spec broadcast_windows_list(Subject.t(), String.t()) :: :ok
  defp broadcast_windows_list(subject, subject_label) do
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
    lower_nick = String.downcase(target_nick)

    query =
      Window
      |> Subject.subject_where(subject)
      |> where([w], w.network_id == ^network_id)
      |> where([w], fragment("lower(?)", w.target_nick) == ^lower_nick)

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
