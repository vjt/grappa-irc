defmodule Grappa.QueryWindows do
  @moduledoc """
  Per-user persisted DM (query) windows — the server-side primitive that
  lets cicchetto restore open query windows across page reloads and device
  switches.

  ## Why this exists

  cicchetto derives channel windows from live IRC JOIN state (no
  persistence needed — you're either joined or you're not). DM windows
  have no equivalent server-side signal; the user just opened a `/msg`
  or clicked a nick. Without this table the window list resets to empty
  on every reload.

  ## What "open" means

  A row in `query_windows` means the user explicitly opened a DM window
  with `target_nick` on `network_id`. The cicchetto C-buckets consume the
  list via Phoenix Channels snapshot on join; individual open/close events
  are pushed as they happen. This table is NOT a conversation record —
  it's purely a UI-state flag. Scrollback is owned by `Grappa.Scrollback`.

  ## Case-insensitive uniqueness

  IRC nicks are case-insensitive (RFC 2812 §2.2). The table's unique
  index is on `(user_id, network_id, lower(target_nick))` so
  "FooBar" and "foobar" are treated as the same DM target. The stored
  `target_nick` column is case-preserving (original input wins).

  ## Idempotent open / close

  Both `open/4` and `close/4` are safe to call multiple times with the
  same arguments. `open/4` returns the existing row on a duplicate call
  without updating it ("first opened" semantics — `opened_at` is a
  stable anchor). `close/4` returns `:ok` whether or not a row existed.

  After every successful call to `open/4` or `close/4`, the current full
  window list is broadcast on `Topic.user(user_name)` as:

      {:event, %{kind: "query_windows_list", windows: list_for_user(user_id)}}

  This lets cicchetto maintain consistent state via a simple `setState`
  rather than tracking individual deltas.

  ## Visitor sessions

  Visitor sessions should NOT call `open/4` (spec line 46: "Skipped for
  visitor sessions" — visitor credentials are ephemeral and their
  network rows cascade on logout anyway). This is a caller-level
  concern; the table imposes no constraint on it.

  ## Boundary

  `Grappa.QueryWindows` is a standalone context. Its only deps are:
    * `Grappa.Repo` — persistence.
    * `Grappa.Accounts` (via `User` association — FK reference only).
    * `Grappa.Networks` (via `Network` association — FK reference only).
    * `Grappa.PubSub` — `Topic.user/1` for the `query_windows_list` broadcast.

  The `Window` schema module is internal; callers receive `%Window{}`
  structs by type but MUST NOT alias or import the schema module
  directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.PubSub, Grappa.Repo],
    exports: [Window]

  import Ecto.Query

  alias Grappa.PubSub.Topic
  alias Grappa.QueryWindows.Window
  alias Grappa.Repo

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @typedoc """
  Wire shape of a single `query_windows_list` event payload — the full current
  window list for the user, keyed by `network_id`.
  """
  @type windows_list_payload :: %{kind: String.t(), windows: %{integer() => [Window.t()]}}

  @doc """
  Idempotently opens a DM window for `target_nick` on `(user_id, network_id)`.

  If a row for the same `(user_id, network_id, lower(target_nick))` already
  exists, returns `{:ok, existing_row}` WITHOUT modifying the existing row
  (`opened_at` is left unchanged — first-opened semantics). If no row
  exists, inserts one with `opened_at = DateTime.utc_now()`.

  After the DB mutation (whether new insert or idempotent re-select), broadcasts
  the full current window list on `Topic.user(user_name)` so connected cicchetto
  clients can update their state.

  The implementation uses `Repo.insert/2` with `on_conflict: :nothing` so
  concurrent callers race on the unique index — the loser finds the row via
  a follow-up `get_by` that uses `lower()` to match case-insensitively.
  Race safety: at most two DB round-trips per contended open.
  """
  @spec open(user_id :: Ecto.UUID.t(), network_id :: integer(), target_nick :: String.t(), user_name :: String.t()) ::
          {:ok, Window.t()} | {:error, Ecto.Changeset.t()}
  def open(user_id, network_id, target_nick, user_name)
      when is_binary(user_id) and is_integer(network_id) and is_binary(target_nick) and
             is_binary(user_name) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    attrs = %{
      user_id: user_id,
      network_id: network_id,
      target_nick: target_nick,
      opened_at: now
    }

    cs = Window.changeset(%Window{}, attrs)

    result =
      case Repo.insert(cs,
             on_conflict: :nothing,
             conflict_target: {:unsafe_fragment, "(user_id, network_id, lower(target_nick))"}
           ) do
        {:ok, %Window{id: nil}} ->
          # on_conflict: :nothing returns a struct with id=nil on conflict.
          # Re-select the existing row case-insensitively.
          fetch_existing(user_id, network_id, target_nick)

        {:ok, window} ->
          {:ok, window}

        {:error, %Ecto.Changeset{} = failed_cs} ->
          {:error, failed_cs}
      end

    case result do
      {:ok, _} = ok ->
        broadcast_windows_list(user_id, user_name)
        ok

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Closes (deletes) the DM window for `target_nick` on `(user_id, network_id)`.

  Case-insensitive: `close(u, n, "FooBar", name)` deletes a "foobar" window.
  Returns `:ok` whether or not a row was deleted (idempotent).

  After the DB delete, broadcasts the full current window list on
  `Topic.user(user_name)` so connected cicchetto clients can update their state.
  """
  @spec close(user_id :: Ecto.UUID.t(), network_id :: integer(), target_nick :: String.t(), user_name :: String.t()) ::
          :ok
  def close(user_id, network_id, target_nick, user_name)
      when is_binary(user_id) and is_integer(network_id) and is_binary(target_nick) and
             is_binary(user_name) do
    lower_nick = String.downcase(target_nick)

    query =
      from(w in Window,
        where:
          w.user_id == ^user_id and
            w.network_id == ^network_id and
            fragment("lower(?)", w.target_nick) == ^lower_nick
      )

    Repo.delete_all(query)
    broadcast_windows_list(user_id, user_name)
    :ok
  end

  @doc """
  Returns all open DM windows for `user_id`, grouped by `network_id`.

  The map keys are integer `network_id`s; values are lists of `%Window{}`
  structs ordered by `opened_at ASC` (oldest-opened first — natural
  display order). When two windows share the same `opened_at` second, `id
  ASC` is the tiebreaker.

  Returns `%{}` when the user has no open windows.
  """
  @spec list_for_user(user_id :: Ecto.UUID.t()) :: %{integer() => [Window.t()]}
  def list_for_user(user_id) when is_binary(user_id) do
    query =
      from(w in Window,
        where: w.user_id == ^user_id,
        order_by: [asc: w.opened_at, asc: w.id]
      )

    query
    |> Repo.all()
    |> Enum.group_by(& &1.network_id)
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec broadcast_windows_list(Ecto.UUID.t(), String.t()) :: :ok
  defp broadcast_windows_list(user_id, user_name) do
    windows = list_for_user(user_id)

    :ok =
      Phoenix.PubSub.broadcast(
        Grappa.PubSub,
        Topic.user(user_name),
        {:event, %{kind: "query_windows_list", windows: windows}}
      )
  end

  @spec fetch_existing(Ecto.UUID.t(), integer(), String.t()) ::
          {:ok, Window.t()} | {:error, Ecto.Changeset.t()}
  defp fetch_existing(user_id, network_id, target_nick) do
    lower_nick = String.downcase(target_nick)

    query =
      from(w in Window,
        where:
          w.user_id == ^user_id and
            w.network_id == ^network_id and
            fragment("lower(?)", w.target_nick) == ^lower_nick
      )

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
        {:error,
         Window.changeset(%Window{}, %{
           user_id: user_id,
           network_id: network_id,
           target_nick: target_nick,
           opened_at: DateTime.utc_now()
         })}
    end
  end
end
