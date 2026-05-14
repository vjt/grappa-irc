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

  | Key                    | Type               | Accessor(s)                     |
  |------------------------|--------------------|---------------------------------|
  | `"highlight_patterns"` | `list(String.t())` | `get_highlight_patterns/1`,     |
  |                        |                    | `set_highlight_patterns/2`      |
  | `"notification_prefs"` | `notification_prefs()` | `get_notification_prefs/1`, |
  |                        |                    | `put_notification_prefs/2`,     |
  |                        |                    | `default_notification_prefs/0`  |

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

  @typedoc """
  Per-user notification preferences — push-notifications cluster B3.

  Five booleans + two string-list whitelists. Whitelist semantics:
  IF `channel_messages_all` is true the `channel_messages_only` list
  is ignored at trigger-eval time (UI greys it out, server still
  stores the value so toggling `_all` off restores the prior list).
  Same for `private_messages_all` / `private_messages_only`.

  Channel names + nicks are stored lowercased + trimmed (set via
  `put_notification_prefs/2`). Trigger eval (B4) uses
  `String.downcase` on incoming message fields so the comparison
  is case-insensitive end-to-end.
  """
  @type notification_prefs :: %{
          channel_messages_all: boolean(),
          channel_messages_only: [String.t()],
          channel_mentions: boolean(),
          private_messages_all: boolean(),
          private_messages_only: [String.t()]
        }

  @notification_prefs_key "notification_prefs"

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
  `Grappa.Accounts.create_session/4`; see S29 H4 + Session schema moduledoc
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
  # notification_prefs accessors (push-notifications cluster B3)
  # ---------------------------------------------------------------------------

  @doc """
  Default notification preferences applied when a user has no row OR
  the `"notification_prefs"` key is absent from `data`.

  Defaults: channel mentions ON, all private messages ON; everything
  else OFF. Empty whitelists. Mirrors the spec's "sensible defaults
  for IRC users" — opt out of all-channel-noise, opt in to mentions
  and DMs.

  The spec's return type is the wider `notification_prefs()` (not the
  Dialyzer-inferred singleton shape) so callers can pattern-match the
  result interchangeably with `get_notification_prefs/1` results.
  """
  @dialyzer {:nowarn_function, default_notification_prefs: 0}
  @spec default_notification_prefs() :: notification_prefs()
  def default_notification_prefs do
    %{
      channel_messages_all: false,
      channel_messages_only: [],
      channel_mentions: true,
      private_messages_all: true,
      private_messages_only: []
    }
  end

  @doc """
  Returns the `notification_prefs` map for `user_id`.

  Falls back to `default_notification_prefs/0` when:
    * no settings row exists for the user;
    * the row exists but has no `"notification_prefs"` key;
    * the stored value is malformed (not a map).

  When the stored map is partially populated (legacy row from a
  previous shape revision), missing keys are filled from defaults
  so the returned shape is ALWAYS a complete `notification_prefs()`.
  Reader is side-effect-free.
  """
  @spec get_notification_prefs(user_id :: Ecto.UUID.t()) :: notification_prefs()
  def get_notification_prefs(user_id) when is_binary(user_id) do
    case Repo.get_by(Settings, user_id: user_id) do
      nil ->
        default_notification_prefs()

      %Settings{data: data} ->
        case data[@notification_prefs_key] do
          %{} = stored -> merge_with_defaults(stored)
          _ -> default_notification_prefs()
        end
    end
  end

  @doc """
  Sets the `notification_prefs` map for `user_id`, preserving any
  other keys already present in `data` (merge semantics, not
  replace — same shape as `set_highlight_patterns/2`).

  ## Validation

    * At least one of the five trigger flags must be true. A prefs
      shape with every trigger off would silently mute the user;
      surface that as `:no_triggers_enabled` rather than persist a
      "notifications never fire" config.
    * `channel_messages_only` and `private_messages_only` must be
      lists of non-empty strings. Channel names AND nicks are
      lowercased + trimmed before persistence (IRC nicks/channels
      are case-insensitive per RFC 2812; storing lowercased keeps
      trigger-eval comparison cheap).
    * Whitelists are stored even when the corresponding `_all` flag
      is true. The UI greys them out; the server uses them only as
      fallback at trigger-eval time. Storing means flipping `_all`
      off restores the user's last list — better UX than discarding.

  Returns `{:ok, %Settings{}}` on persistence; `{:error, changeset}`
  with descriptive errors on either validation failure path.
  """
  @spec put_notification_prefs(user_id :: Ecto.UUID.t(), prefs :: notification_prefs()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def put_notification_prefs(user_id, prefs) when is_binary(user_id) and is_map(prefs) do
    with {:ok, normalized} <- validate_and_normalize_prefs(prefs, user_id),
         {:ok, settings} <- get_or_init(user_id) do
      merged_data = Map.put(settings.data, @notification_prefs_key, stringify_prefs(normalized))
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
  # issue as Accounts.create_session/4; see S29 H4). We check with Repo.exists?
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

  # ---------------------------------------------------------------------------
  # notification_prefs helpers
  # ---------------------------------------------------------------------------

  @prefs_bool_keys ~w(channel_messages_all channel_mentions private_messages_all)a
  @prefs_list_keys ~w(channel_messages_only private_messages_only)a
  @prefs_trigger_keys ~w(channel_messages_all channel_mentions private_messages_all)a

  # Reads atom + string keys from `stored` (post-DB-roundtrip is string),
  # fills missing keys from defaults so the returned shape is always
  # the full notification_prefs() type.
  @spec merge_with_defaults(map()) :: notification_prefs()
  defp merge_with_defaults(stored) do
    defaults = default_notification_prefs()

    bools =
      Map.new(@prefs_bool_keys, fn key ->
        {key, read_bool(stored, key, Map.fetch!(defaults, key))}
      end)

    lists =
      Map.new(@prefs_list_keys, fn key ->
        {key, read_list(stored, key, Map.fetch!(defaults, key))}
      end)

    Map.merge(bools, lists)
  end

  defp read_bool(stored, key, default) do
    case Map.get(stored, key, Map.get(stored, Atom.to_string(key))) do
      v when is_boolean(v) -> v
      _ -> default
    end
  end

  defp read_list(stored, key, default) do
    case Map.get(stored, key, Map.get(stored, Atom.to_string(key))) do
      list when is_list(list) -> Enum.filter(list, &(is_binary(&1) and byte_size(&1) > 0))
      _ -> default
    end
  end

  # Validates trigger-enabled invariant + normalizes whitelist members.
  # Whitelists are normalized regardless of corresponding `_all` flag —
  # storing the user's list lets the UI restore it when `_all` is toggled
  # off later.
  @spec validate_and_normalize_prefs(map(), Ecto.UUID.t()) ::
          {:ok, notification_prefs()} | {:error, Ecto.Changeset.t()}
  defp validate_and_normalize_prefs(prefs, user_id) do
    with {:ok, bools} <- cast_bools(prefs, user_id),
         {:ok, lists} <- cast_lists(prefs, user_id),
         normalized = Map.merge(bools, lists),
         :ok <- ensure_at_least_one_trigger(normalized, user_id) do
      {:ok, normalized}
    end
  end

  defp cast_bools(prefs, user_id), do: cast_bools(@prefs_bool_keys, prefs, user_id, %{})
  defp cast_bools([], _, _, acc), do: {:ok, acc}

  defp cast_bools([key | rest], prefs, user_id, acc) do
    case fetch_bool(prefs, key) do
      {:ok, v} ->
        cast_bools(rest, prefs, user_id, Map.put(acc, key, v))

      :error ->
        {:error, prefs_changeset_error("#{key} must be a boolean", user_id)}
    end
  end

  defp cast_lists(prefs, user_id), do: cast_lists(@prefs_list_keys, prefs, user_id, %{})
  defp cast_lists([], _, _, acc), do: {:ok, acc}

  defp cast_lists([key | rest], prefs, user_id, acc) do
    case fetch_list(prefs, key) do
      {:ok, v} ->
        cast_lists(rest, prefs, user_id, Map.put(acc, key, normalize_list(v)))

      {:error, reason} ->
        {:error, prefs_changeset_error("#{key} #{reason}", user_id)}
    end
  end

  defp fetch_bool(prefs, key) do
    case Map.get(prefs, key, Map.get(prefs, Atom.to_string(key))) do
      v when is_boolean(v) -> {:ok, v}
      _ -> :error
    end
  end

  defp fetch_list(prefs, key) do
    case Map.get(prefs, key, Map.get(prefs, Atom.to_string(key))) do
      list when is_list(list) ->
        if Enum.all?(list, &is_binary/1),
          do: {:ok, list},
          else: {:error, "elements must be strings"}

      _ ->
        {:error, "must be a list of strings"}
    end
  end

  # lowercase + trim + drop empties + dedup. Preserves order on first occurrence.
  defp normalize_list(list) do
    list
    |> Enum.map(&(&1 |> String.trim() |> String.downcase()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp ensure_at_least_one_trigger(prefs, user_id) do
    if Enum.any?(@prefs_trigger_keys, &Map.fetch!(prefs, &1)) do
      :ok
    else
      {:error, prefs_changeset_error("at least one trigger must be enabled", user_id)}
    end
  end

  defp prefs_changeset_error(message, user_id) do
    %Settings{}
    |> Settings.changeset(%{user_id: user_id, data: %{}})
    |> Ecto.Changeset.add_error(:notification_prefs, message)
  end

  # Convert atom-keyed prefs to string-keyed before persisting so the
  # in-memory shape matches the post-DB-roundtrip shape — readers always
  # see string keys, no atom-vs-string drift.
  @spec stringify_prefs(notification_prefs()) :: %{String.t() => term()}
  defp stringify_prefs(prefs) do
    Map.new(prefs, fn {k, v} -> {Atom.to_string(k), v} end)
  end
end
