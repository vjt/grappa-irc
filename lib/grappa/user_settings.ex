defmodule Grappa.UserSettings do
  @moduledoc """
  Per-subject settings store — a JSON column per subject that
  accumulates preference keys without per-key migrations.

  ## Why this exists

  Subject-visible preferences (highlight watchlist, future UI
  toggles, notification thresholds) are small, numerous, and
  orthogonal. Storing each in its own column requires an ALTER TABLE
  per setting. A single `:map` JSON column (`data`) allows arbitrary
  new keys without schema changes; per-key shape rules live in typed
  accessor functions here.

  ## Subject-scoped (visitor-parity V1, 2026-05-15)

  The module name (`UserSettings`) is retained for stability — both
  registered users and visitors persist settings here, with storage
  using the XOR FK shape (`user_id` XOR `visitor_id`) proven by
  `Grappa.Scrollback.Message` and `Grappa.ReadCursor.Cursor`. Visitor
  reaping CASCADEs the rows on TTL expiry.

  Every public function takes a `Grappa.Subject.t()` tagged tuple
  rather than a raw `user_id`.

  ## Access model

  - **Writers** use `get_or_init/1` first (which creates the row on
    first access), then a typed accessor (`set_highlight_patterns/2`).
  - **Readers** use typed accessors directly (`get_highlight_patterns/1`),
    which return safe defaults (`[]`, `nil`, etc.) when no row exists.
    Readers do NOT auto-create the row — side-effect-free reads are
    observable-stable and don't pollute the DB with empty rows.

  ## String-key invariant

  Ecto encodes `:map` fields via Jason. After a DB round-trip, atom
  keys become string keys. ALL accessors in this module MUST read
  `data` with string keys (e.g. `data["highlight_patterns"]`, NOT
  `data.highlight_patterns`).

  ## Known settings keys

  | Key                    | Type                   | Accessor(s)                     |
  |------------------------|------------------------|---------------------------------|
  | `"highlight_patterns"` | `list(String.t())`     | `get_highlight_patterns/1`,     |
  |                        |                        | `set_highlight_patterns/2`      |
  | `"notification_prefs"` | `notification_prefs()` | `get_notification_prefs/1`,     |
  |                        |                        | `put_notification_prefs/2`,     |
  |                        |                        | `default_notification_prefs/0`  |
  | `"upload_ttl_seconds"` | `pos_integer() \\| nil`| `get_upload_ttl_seconds/1`,     |
  |                        |                        | `put_upload_ttl_seconds/2`      |
  | `"vhost_selection"`    | `list(String.t())`     | `get_vhost_selection/1`,        |
  |                        |                        | `put_vhost_selection/2`         |
  | `"active_theme_id"`    | `pos_integer() \\| nil`| `get_active_theme_id/1`,        |
  |                        |                        | `put_active_theme_id/2`         |

  ## Boundary

  `Grappa.UserSettings` is a standalone context. Its only deps are:
    * `Grappa.Repo` — persistence.
    * `Grappa.Subject` — XOR FK helper.
    * `Grappa.Accounts` (via `User` association — FK reference only).
    * `Grappa.Visitors` (via `Visitor` association — FK reference only).

  The `Settings` schema module is internal; callers receive
  `%Settings{}` structs by type but MUST NOT alias or import the
  schema module directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo, Grappa.Subject],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Settings]

  import Ecto.Query

  alias Grappa.{Accounts.User, IRC.Identifier, Repo, Subject, UserSettings.Settings, Visitors.Visitor}

  @typedoc """
  Per-subject notification preferences — push-notifications cluster B3.

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
  @upload_ttl_seconds_key "upload_ttl_seconds"
  @vhost_selection_key "vhost_selection"
  @active_theme_id_key "active_theme_id"

  # Upper bound for upload_ttl_seconds: one year. Image hosts (litterbox,
  # 0x0.st) cap at days; nobody legitimately wants a year-long TTL token
  # for a transient screenshot. A bound this loose accepts whatever ladder
  # cic surfaces today while making "100-year TTL DOS body" return 422.
  @upload_ttl_seconds_max 31_536_000

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Returns the settings row for `subject`, creating an empty one if
  it does not yet exist.

  This is the write-path entry point: callers that intend to mutate
  settings (`set_highlight_patterns/2` uses it internally) call
  `get_or_init/1` first to ensure a row exists.

  **Race safety**: two concurrent `get_or_init/1` calls for the same
  subject race on the per-subject partial unique index. The loser
  gets `on_conflict: :nothing` (id=nil struct), triggering a
  re-select. At most two DB round-trips per contended init.

  Returns `{:error, changeset}` when the subject does not exist in
  its respective table. This is a pre-flight existence check
  (`Repo.exists?`) rather than relying on the DB FK constraint name
  — `ecto_sqlite3` returns FK constraint names as `nil`, so Ecto
  can't map them to changeset errors (same limitation as
  `Grappa.Accounts.create_session/4` + `Grappa.QueryWindows.open/4`).
  The pre-flight check is benign-racy: a concurrently deleted
  subject would still trip the DB FK as a backstop (raising
  `Ecto.ConstraintError`, acceptable for that edge case).
  """
  @spec get_or_init(Subject.t()) :: {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def get_or_init({_, _} = subject) do
    with :ok <- validate_subject_exists(subject) do
      attrs = Subject.put_subject_id(%{data: %{}}, subject)
      cs = Settings.changeset(%Settings{}, attrs)

      case Repo.insert(cs, on_conflict: :nothing, conflict_target: conflict_target(subject)) do
        {:ok, %Settings{id: nil}} ->
          fetch_existing(subject)

        {:ok, settings} ->
          {:ok, settings}

        {:error, %Ecto.Changeset{} = failed_cs} ->
          {:error, failed_cs}
      end
    end
  end

  @doc """
  Returns the `highlight_patterns` list for `subject`.

  If no settings row exists, returns `[]` — does NOT create the row
  (readers must be side-effect-free). If the `"highlight_patterns"`
  key is missing from `data`, or is present but not a list, returns
  `[]` (defensive read — JSON round-trips could deliver unexpected
  shapes if a miscoded writer bypassed the typed accessor).

  Reads with string key `"highlight_patterns"` — required because
  Ecto's `:map` type decodes JSON with string keys after a DB
  round-trip.
  """
  @spec get_highlight_patterns(Subject.t()) :: [String.t()]
  def get_highlight_patterns({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
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
  Sets the `highlight_patterns` list for `subject`, preserving any
  other keys already present in `data`.

  Calls `get_or_init/1` internally to ensure the row exists before
  updating. The merge strategy is: fetch `data`, put
  `"highlight_patterns" => patterns`, then update. Other `data` keys
  are untouched.

  **Validation**: every element of `patterns` must be a non-empty
  binary. Returns `{:error, %Ecto.Changeset{}}` if validation fails,
  BEFORE any DB work.

  **Out of scope**: deduplication, case-folding, and regex
  validation of pattern syntax are the responsibility of the matcher
  logic (C7.7 / S3.5). This function stores what the caller passes
  (after the non-empty-binary check).

  The `is_list(patterns)` guard is part of the function head to make
  the type contract explicit at the call site.
  """
  @spec set_highlight_patterns(Subject.t(), [String.t()]) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def set_highlight_patterns({_, _} = subject, patterns) when is_list(patterns) do
    with :ok <- validate_patterns(patterns, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, "highlight_patterns", patterns)
      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  @doc """
  Test-support: deletes the `user_settings` row for `user_id` so
  subsequent reads return defaults. Intended for
  `Grappa.TestSupport.SubjectReset` only — production lifecycle uses
  per-field putters (`set_highlight_patterns/2`,
  `put_notification_prefs/2`, `put_upload_ttl_seconds/2`).
  """
  @spec reset_for_user(Ecto.UUID.t()) :: :ok
  def reset_for_user(user_id) when is_binary(user_id) do
    query = from(s in Settings, where: s.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
  end

  # ---------------------------------------------------------------------------
  # notification_prefs accessors (push-notifications cluster B3)
  # ---------------------------------------------------------------------------

  @doc """
  Default notification preferences applied when a subject has no row
  OR the `"notification_prefs"` key is absent from `data`.

  Defaults: channel mentions ON, all private messages ON; everything
  else OFF. Empty whitelists. Mirrors the spec's "sensible defaults
  for IRC users" — opt out of all-channel-noise, opt in to mentions
  and DMs.

  The spec's return type is the wider `notification_prefs()` (not the
  Dialyzer-inferred singleton shape) so callers can pattern-match
  the result interchangeably with `get_notification_prefs/1` results.
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
  Returns the `notification_prefs` map for `subject`.

  Falls back to `default_notification_prefs/0` when:
    * no settings row exists for the subject;
    * the row exists but has no `"notification_prefs"` key;
    * the stored value is malformed (not a map).

  When the stored map is partially populated (legacy row from a
  previous shape revision), missing keys are filled from defaults
  so the returned shape is ALWAYS a complete `notification_prefs()`.
  Reader is side-effect-free.
  """
  @spec get_notification_prefs(Subject.t()) :: notification_prefs()
  def get_notification_prefs({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
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
  Sets the `notification_prefs` map for `subject`, preserving any
  other keys already present in `data` (merge semantics, not
  replace — same shape as `set_highlight_patterns/2`).

  ## Validation

    * At least one of the five trigger flags must be true. A prefs
      shape with every trigger off would silently mute the subject;
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
      off restores the subject's last list — better UX than
      discarding.

  Returns `{:ok, %Settings{}}` on persistence; `{:error, changeset}`
  with descriptive errors on either validation failure path.
  """
  @spec put_notification_prefs(Subject.t(), notification_prefs()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def put_notification_prefs({_, _} = subject, prefs) when is_map(prefs) do
    with {:ok, normalized} <- validate_and_normalize_prefs(prefs, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @notification_prefs_key, stringify_prefs(normalized))
      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  # ---------------------------------------------------------------------------
  # upload_ttl_seconds accessors (UX-4 bucket M, 2026-05-19)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the stored upload-TTL preference for `subject`, in seconds.

  Returns `nil` when no row exists, the row has no `"upload_ttl_seconds"`
  key, or the stored value is malformed (not a positive integer in
  range). `nil` is the "use system default" sentinel — the image-upload
  orchestrator falls back to the active host's `defaultTtl` when this
  is nil.

  Reads with string key `"upload_ttl_seconds"` — Ecto's `:map` decodes
  JSON with string keys after a DB round-trip.
  """
  @spec get_upload_ttl_seconds(Subject.t()) :: pos_integer() | nil
  def get_upload_ttl_seconds({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        nil

      %Settings{data: data} ->
        case data[@upload_ttl_seconds_key] do
          n when is_integer(n) and n > 0 and n <= @upload_ttl_seconds_max -> n
          _ -> nil
        end
    end
  end

  @doc """
  Sets the upload-TTL preference for `subject`, in seconds. Pass `nil`
  to clear the preference (revert to system default).

  Validates that `seconds` is `nil` OR a positive integer
  `<= #{@upload_ttl_seconds_max}` (1 year — bounds an accidental DOS
  shape, see moduledoc note on `@upload_ttl_seconds_max`).

  Preserves other keys in `data` (merge semantics, mirror of
  `set_highlight_patterns/2` + `put_notification_prefs/2`).
  """
  @spec put_upload_ttl_seconds(Subject.t(), pos_integer() | nil) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def put_upload_ttl_seconds({_, _} = subject, seconds) do
    with :ok <- validate_upload_ttl_seconds(seconds, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data =
        case seconds do
          nil -> Map.delete(settings.data, @upload_ttl_seconds_key)
          n -> Map.put(settings.data, @upload_ttl_seconds_key, n)
        end

      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  @spec validate_upload_ttl_seconds(term(), Subject.t()) ::
          :ok | {:error, Ecto.Changeset.t()}
  defp validate_upload_ttl_seconds(nil, _), do: :ok

  defp validate_upload_ttl_seconds(n, _)
       when is_integer(n) and n > 0 and n <= @upload_ttl_seconds_max,
       do: :ok

  defp validate_upload_ttl_seconds(_, subject) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    cs =
      %Settings{}
      |> Settings.changeset(attrs)
      |> Ecto.Changeset.add_error(
        :upload_ttl_seconds,
        "must be a positive integer up to #{@upload_ttl_seconds_max} seconds, or null"
      )

    {:error, cs}
  end

  # ---------------------------------------------------------------------------
  # vhost_selection accessors (#228)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the subject's raw vhost self-selection — a list of source-bind
  address strings. Returns `[]` when no row exists, the key is absent, or
  the stored value is malformed.

  This is the RAW persisted list; authorization (each address ∈ the
  subject's allowed set) is enforced by `Grappa.Vhosts` at write, and the
  allowed-set intersection re-clamp happens on read there. This accessor
  stores/returns exactly what `Grappa.Vhosts` persists, mirroring the
  `highlight_patterns` string-list contract.
  """
  @spec get_vhost_selection(Subject.t()) :: [String.t()]
  def get_vhost_selection({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        []

      %Settings{data: data} ->
        case data[@vhost_selection_key] do
          list when is_list(list) -> Enum.filter(list, &is_binary/1)
          _ -> []
        end
    end
  end

  @doc """
  Persists the subject's vhost self-selection (list of address strings),
  preserving other keys in `data` (merge semantics). Validates every
  element is a non-empty binary; authorization is the caller's
  (`Grappa.Vhosts`) responsibility.
  """
  @spec put_vhost_selection(Subject.t(), [String.t()]) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def put_vhost_selection({_, _} = subject, addresses) when is_list(addresses) do
    with :ok <- validate_vhost_selection(addresses, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @vhost_selection_key, addresses)
      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  @spec validate_vhost_selection([term()], Subject.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_vhost_selection(addresses, subject) do
    if Enum.all?(addresses, &(is_binary(&1) and byte_size(&1) > 0)) do
      :ok
    else
      attrs = Subject.put_subject_id(%{data: %{}}, subject)

      cs =
        %Settings{}
        |> Settings.changeset(attrs)
        |> Ecto.Changeset.add_error(:data, "vhost_selection elements must be non-empty strings")

      {:error, cs}
    end
  end

  # ---------------------------------------------------------------------------
  # active_theme_id accessor (#75 themes)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the subject's active theme id (the `themes.id` pointer), or `nil`
  when no row exists, the key is absent, or the stored value is malformed.

  `nil` means "no theme chosen" — the caller
  (`Grappa.Themes.get_active_theme/1`) falls back to the client/default look.
  Reads with the string key (`:map` JSON round-trip).
  """
  @spec get_active_theme_id(Subject.t()) :: pos_integer() | nil
  def get_active_theme_id({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        nil

      %Settings{data: data} ->
        case data[@active_theme_id_key] do
          n when is_integer(n) and n > 0 -> n
          _ -> nil
        end
    end
  end

  @doc """
  Sets the subject's active theme id (a positive `themes.id`), or clears it
  with `nil`. Preserves other keys in `data` (merge semantics). Validates the
  id is `nil` or a positive integer; confirming that the id references a
  readable theme is the caller's job (`Grappa.Themes.set_active_theme/2`).
  """
  @spec put_active_theme_id(Subject.t(), pos_integer() | nil) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  def put_active_theme_id({_, _} = subject, id) do
    with :ok <- validate_active_theme_id(id, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data =
        case id do
          nil -> Map.delete(settings.data, @active_theme_id_key)
          n -> Map.put(settings.data, @active_theme_id_key, n)
        end

      cs = Settings.changeset(settings, %{data: merged_data})
      Repo.update(cs)
    end
  end

  @spec validate_active_theme_id(term(), Subject.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_active_theme_id(nil, _), do: :ok
  defp validate_active_theme_id(n, _) when is_integer(n) and n > 0, do: :ok

  defp validate_active_theme_id(_, subject) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    cs =
      %Settings{}
      |> Settings.changeset(attrs)
      |> Ecto.Changeset.add_error(:active_theme_id, "must be a positive integer or null")

    {:error, cs}
  end

  @doc """
  How many subjects (users AND visitors) currently have theme `theme_id` set as
  their active theme (#299 item 9 — the real "in use" metric, distinct from the
  copy-popularity `apply_count`). `active_theme_id` is a JSON key in `data`, so
  the count is a `json_extract` predicate over `user_settings`.
  """
  @spec count_active_theme_users(pos_integer()) :: non_neg_integer()
  def count_active_theme_users(theme_id) when is_integer(theme_id) do
    Settings
    |> where([s], fragment("json_extract(?, '$.active_theme_id')", s.data) == ^theme_id)
    |> Repo.aggregate(:count, :id)
  end

  @doc """
  Active-theme usage counts for EVERY theme in one pass: `%{theme_id => count}`
  (#299 item 9). The batched sibling of `count_active_theme_users/1` — the
  gallery/owned listings use it to populate each theme's `in_use` without an
  N+1. Rows with no active theme (`json_extract` → NULL) are excluded.
  """
  @spec active_theme_counts() :: %{pos_integer() => non_neg_integer()}
  def active_theme_counts do
    Settings
    |> group_by([s], fragment("json_extract(?, '$.active_theme_id')", s.data))
    |> select([s], {fragment("json_extract(?, '$.active_theme_id')", s.data), count(s.id)})
    |> Repo.all()
    |> Enum.reject(fn {theme_id, _} -> is_nil(theme_id) end)
    |> Map.new()
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Mirror of `Grappa.QueryWindows.conflict_target/1` — partial
  # indexes carry the predicate so the upsert must repeat it.
  defp conflict_target({:user, _}),
    do: {:unsafe_fragment, "(user_id) WHERE user_id IS NOT NULL"}

  defp conflict_target({:visitor, _}),
    do: {:unsafe_fragment, "(visitor_id) WHERE visitor_id IS NOT NULL"}

  @spec fetch_existing(Subject.t()) :: {:ok, Settings.t()} | {:error, Ecto.Changeset.t()}
  defp fetch_existing(subject) do
    case fetch_existing_or_nil(subject) do
      %Settings{} = settings ->
        {:ok, settings}

      nil ->
        # Should not happen: on_conflict: :nothing means a row existed at
        # insert time; it couldn't have been deleted in the tiny window
        # between conflict detection and the re-select. This path is
        # effectively unreachable in production.
        attrs = Subject.put_subject_id(%{data: %{}}, subject)
        {:error, Settings.changeset(%Settings{}, attrs)}
    end
  end

  @spec fetch_existing_or_nil(Subject.t()) :: Settings.t() | nil
  defp fetch_existing_or_nil(subject) do
    Settings
    |> Subject.subject_where(subject)
    |> Repo.one()
  end

  # Pre-flight existence check for the subject's FK target.
  # ecto_sqlite3 returns FK constraint names as nil so Ecto can't map
  # DB FK violations to changeset errors (same issue as
  # Accounts.create_session/4; see S29 H4). We check with
  # `Repo.exists?` before insert so the {:error, changeset} return
  # contract is honoured.
  @spec validate_subject_exists(Subject.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_subject_exists({:user, user_id}),
    do: do_validate_subject_exists(user_id, User, :user, {:user, user_id})

  defp validate_subject_exists({:visitor, visitor_id}),
    do: do_validate_subject_exists(visitor_id, Visitor, :visitor, {:visitor, visitor_id})

  defp do_validate_subject_exists(id, schema, error_field, subject) do
    query = from(row in schema, where: row.id == ^id)

    if Repo.exists?(query) do
      :ok
    else
      attrs = Subject.put_subject_id(%{data: %{}}, subject)

      cs =
        %Settings{}
        |> Settings.changeset(attrs)
        |> Ecto.Changeset.add_error(error_field, "does not exist")

      {:error, cs}
    end
  end

  @spec validate_patterns([term()], Subject.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_patterns(patterns, subject) do
    if Enum.all?(patterns, &(is_binary(&1) and byte_size(&1) > 0)) do
      :ok
    else
      attrs = Subject.put_subject_id(%{data: %{}}, subject)

      cs =
        %Settings{}
        |> Settings.changeset(attrs)
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
  # storing the subject's list lets the UI restore it when `_all` is
  # toggled off later.
  @spec validate_and_normalize_prefs(map(), Subject.t()) ::
          {:ok, notification_prefs()} | {:error, Ecto.Changeset.t()}
  defp validate_and_normalize_prefs(prefs, subject) do
    with {:ok, bools} <- cast_bools(prefs, subject),
         {:ok, lists} <- cast_lists(prefs, subject),
         normalized = Map.merge(bools, lists),
         :ok <- ensure_at_least_one_trigger(normalized, subject) do
      {:ok, normalized}
    end
  end

  defp cast_bools(prefs, subject), do: cast_bools(@prefs_bool_keys, prefs, subject, %{})
  defp cast_bools([], _, _, acc), do: {:ok, acc}

  defp cast_bools([key | rest], prefs, subject, acc) do
    case fetch_bool(prefs, key) do
      {:ok, v} ->
        cast_bools(rest, prefs, subject, Map.put(acc, key, v))

      :error ->
        {:error, prefs_changeset_error("#{key} must be a boolean", subject)}
    end
  end

  defp cast_lists(prefs, subject), do: cast_lists(@prefs_list_keys, prefs, subject, %{})
  defp cast_lists([], _, _, acc), do: {:ok, acc}

  defp cast_lists([key | rest], prefs, subject, acc) do
    case fetch_list(prefs, key) do
      {:ok, v} ->
        cast_lists(rest, prefs, subject, Map.put(acc, key, normalize_list(v, key)))

      {:error, reason} ->
        {:error, prefs_changeset_error("#{key} #{reason}", subject)}
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

  # trim + case-fold + drop empties + dedup. Preserves order on first
  # occurrence. The fold is identity-key-correct per list type (#121):
  # `private_messages_only` is a nick list → canonical_nick/1 (rfc1459,
  # folds `[ ] \ ~` → `{ } | ^`); `channel_messages_only` is a channel
  # list → canonical_channel/1 (sigil-gated rfc1459 fold, #364 — folds
  # `[ ] \ ~` like nicks). A bare String.downcase would fork
  # foo[bar]/foo{bar} on bahamut and never match the folded sender in
  # Triggers.sender_in_whitelist?/2.
  defp normalize_list(list, key) do
    fold = list_fold(key)

    list
    |> Enum.map(&(&1 |> String.trim() |> fold.()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp list_fold(:private_messages_only), do: &Identifier.canonical_nick/1
  defp list_fold(:channel_messages_only), do: &Identifier.canonical_channel/1

  defp ensure_at_least_one_trigger(prefs, subject) do
    if Enum.any?(@prefs_trigger_keys, &Map.fetch!(prefs, &1)) do
      :ok
    else
      {:error, prefs_changeset_error("at least one trigger must be enabled", subject)}
    end
  end

  defp prefs_changeset_error(message, subject) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    %Settings{}
    |> Settings.changeset(attrs)
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
