defmodule Grappa.UserSettings do
  @moduledoc """
  Per-user settings store — a JSON column per user that accumulates
  preference keys without per-key migrations.

  ## Why this exists

  User-visible preferences (highlight watchlist, future UI toggles,
  notification thresholds) are small, numerous, and orthogonal. Storing each
  in its own column requires an ALTER TABLE per setting. A single `:map` JSON
  column (`data`) allows arbitrary new keys without schema changes; per-key
  shape rules live in typed accessor functions here.

  ## Access model

  - **Writers** use `get_or_init/1` first (which creates the row on first
    access), then a typed accessor (`set_highlight_patterns/2`).
  - **Readers** use typed accessors directly (`get_highlight_patterns/1`),
    which return safe defaults (`[]`, `nil`, etc.) when no row exists.
    Readers do NOT auto-create the row — side-effect-free reads are
    observable-stable and don't pollute the DB with empty rows.

  ## String-key invariant

  Ecto encodes `:map` fields via Jason. After a DB round-trip, atom keys
  become string keys. ALL accessors in this module MUST read `data` with
  string keys (e.g. `data["highlight_patterns"]`, NOT `data.highlight_patterns`).

  ## Known settings keys

  | Key                   | Type               | Accessor(s)                     |
  |-----------------------|--------------------|---------------------------------|
  | `"highlight_patterns"` | `list(String.t())` | `get_highlight_patterns/1`,     |
  |                       |                    | `set_highlight_patterns/2`      |

  ## Boundary

  `Grappa.UserSettings` is a standalone context. Its only deps are:
    * `Grappa.Repo` — persistence.
    * `Grappa.Accounts` (via `User` association — FK reference only).

  The `Settings` schema module is internal; callers receive `%Settings{}`
  structs by type but MUST NOT alias or import the schema module directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Repo],
    exports: [Settings]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Repo
  alias Grappa.UserSettings.Settings

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Returns the settings row for `user_id`, creating an empty one if it does
  not yet exist.

  This is the write-path entry point: callers that intend to mutate settings
  (`set_highlight_patterns/2` uses it internally) call `get_or_init/1` first
  to ensure a row exists.

  **Race safety**: two concurrent `get_or_init/1` calls for the same user
  race on the unique index. The loser gets `on_conflict: :nothing` (id=nil
  struct), triggering a re-select. At most two DB round-trips per contented
  init.

  Returns `{:error, changeset}` when `user_id` does not exist in `users`.
  This is a pre-flight existence check (`Repo.exists?`) rather than relying
  on the DB FK constraint name — `ecto_sqlite3` returns FK constraint names
  as `nil`, so Ecto can't map them to changeset errors (same limitation as
  `Grappa.Accounts.create_session/3`; see S29 H4 + Session schema moduledoc
  for the prior art). The pre-flight check is benign-racy: a concurrently
  deleted user would still trip the DB FK as a backstop (raising
  `Ecto.ConstraintError`, which is acceptable for that edge case).
  """
  @spec get_or_init(user_id :: Ecto.UUID.t()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def get_or_init(user_id) when is_binary(user_id) do
    with :ok <- validate_user_exists(user_id) do
      cs = Settings.changeset(%Settings{}, %{user_id: user_id, data: %{}})

      case Repo.insert(cs, on_conflict: :nothing, conflict_target: [:user_id]) do
        {:ok, %Settings{id: nil}} ->
          # Conflict: row already exists — re-select it.
          fetch_existing(user_id)

        {:ok, settings} ->
          {:ok, settings}

        {:error, %Ecto.Changeset{} = failed_cs} ->
          {:error, failed_cs}
      end
    end
  end

  @doc """
  Returns the `highlight_patterns` list for `user_id`.

  If no settings row exists for the user, returns `[]` — does NOT create the
  row (readers must be side-effect-free). If the `"highlight_patterns"` key
  is missing from `data`, or is present but not a list, returns `[]`
  (defensive read — JSON round-trips could deliver unexpected shapes if a
  miscoded writer bypassed the typed accessor).

  Reads with string key `"highlight_patterns"` — required because Ecto's
  `:map` type decodes JSON with string keys after a DB round-trip.
  """
  @spec get_highlight_patterns(user_id :: Ecto.UUID.t()) :: [String.t()]
  def get_highlight_patterns(user_id) when is_binary(user_id) do
    case Repo.get_by(Settings, user_id: user_id) do
      nil ->
        []

      %Settings{data: data} ->
        case data["highlight_patterns"] do
          list when is_list(list) -> list
          _ -> []
        end
    end
  end

  @doc """
  Sets the `highlight_patterns` list for `user_id`, preserving any other
  keys already present in `data`.

  Calls `get_or_init/1` internally to ensure the row exists before updating.
  The merge strategy is: fetch `data`, put `"highlight_patterns" => patterns`,
  then update. Other `data` keys are untouched.

  **Validation**: every element of `patterns` must be a non-empty binary.
  Returns `{:error, %Ecto.Changeset{}}` if validation fails, BEFORE any DB
  work.

  **Out of scope**: deduplication, case-folding, and regex validation of
  pattern syntax are the responsibility of the matcher logic (C7.7 / S3.5).
  This function stores what the caller passes (after the non-empty-binary
  check).

  The `is_list(patterns)` guard is part of the function head to make
  the type contract explicit at the call site.
  """
  @spec set_highlight_patterns(user_id :: Ecto.UUID.t(), patterns :: [String.t()]) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def set_highlight_patterns(user_id, patterns)
      when is_binary(user_id) and is_list(patterns) do
    with :ok <- validate_patterns(patterns),
         {:ok, settings} <- get_or_init(user_id) do
      merged_data = Map.put(settings.data, "highlight_patterns", patterns)
      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec fetch_existing(Ecto.UUID.t()) :: {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  defp fetch_existing(user_id) do
    case Repo.get_by(Settings, user_id: user_id) do
      %Settings{} = settings ->
        {:ok, settings}

      nil ->
        # Should not happen: on_conflict: :nothing means a row existed at
        # insert time; it couldn't have been deleted in the tiny window
        # between conflict detection and the re-select. This path is
        # effectively unreachable in production.
        {:error, Settings.changeset(%Settings{}, %{user_id: user_id, data: %{}})}
    end
  end

  # Pre-flight existence check for user_id. ecto_sqlite3 returns FK constraint
  # names as nil so Ecto can't map DB FK violations to changeset errors (same
  # issue as Accounts.create_session/3; see S29 H4). We check with Repo.exists?
  # before insert so the {:error, changeset} return contract is honoured.
  @spec validate_user_exists(Ecto.UUID.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_user_exists(user_id) do
    query = from(u in User, where: u.id == ^user_id)

    if Repo.exists?(query) do
      :ok
    else
      cs =
        %Settings{}
        |> Settings.changeset(%{user_id: user_id, data: %{}})
        |> Ecto.Changeset.add_error(:user, "does not exist")

      {:error, cs}
    end
  end

  @spec validate_patterns([term()]) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_patterns(patterns) do
    if Enum.all?(patterns, &(is_binary(&1) and byte_size(&1) > 0)) do
      :ok
    else
      cs =
        %Settings{}
        |> Settings.changeset(%{user_id: Ecto.UUID.generate(), data: %{}})
        |> Ecto.Changeset.add_error(
          :data,
          "highlight_patterns elements must be non-empty strings"
        )

      {:error, cs}
    end
  end
end
