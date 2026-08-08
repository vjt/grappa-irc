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
  |                        |                        | `put_theme_pair/3` (#358)       |
  | `"dark_theme_id"`      | `pos_integer() \\| nil`| `get_dark_theme_id/1`,          |
  |                        |                        | `put_theme_pair/3` (#358)       |
  | `"aliases"`            | `%{String.t() =>       | `get_aliases/1`,                |
  |                        | String.t()}`           | `set_aliases/2` (#385)          |
  | `"display_prefs"`      | `display_prefs()`      | `get_display_prefs/1`,          |
  |                        |                        | `put_display_prefs/2`,          |
  |                        |                        | `display_prefs_persisted?/1`    |
  |                        |                        | (#449)                          |
  | `"last_client_prefix64"`| `String.t() \\| nil`  | `get_last_client_prefix64/1`,   |
  |                        | (opaque base16)        | `put_last_client_prefix64/2`    |
  |                        |                        | (#543)                          |

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
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo, Grappa.Subject, Grappa.Visitors.Visitor],
    exports: [Settings]

  import Ecto.Query

  alias Grappa.{Accounts.User, IRC.Identifier, Repo, Subject, UserSettings.Settings, Visitors.Visitor}

  @typedoc """
  Per-conversation notification mutes (#866) — the one DENY-list in
  `notification_prefs()`, where everything else is an allow-list.

  Keyed by the composite `ChannelKey` — `Identifier.channel_key/2`,
  `"<slug> <folded target>"` — where the target is the channel for a channel
  and the PEER's nick for a DM. NOT the row's `channel` field: an inbound DM
  is persisted with `channel = own_nick`, so that key would make a single
  entry silence every DM the subject receives. The channel pattern still
  holds within the composite: build at write, compare `==` at read.

  ## The network is IN the key, and that reverses #866 (#1038)

  #866 shipped a network-blind key and said so on purpose: `user_settings`
  is per-SUBJECT, like `channel_messages_only` beside it, so `#grappa` was
  ONE mute everywhere. vjt withdrew that on 2026-08-08 — muting `#linux` on
  Libera also silenced `#linux` on Azzurra, and the settings list could not
  name the network because there wasn't one. The per-subject storage is
  unchanged; only the key grew a network component.

  The composite is not a shape invented here: it is the same cross-stack
  `ChannelKey` cic builds with `channelKey(slug, name)` and the presence-pin
  resolver keys on. One builder, one decoder, in `Grappa.IRC.Identifier`.

  A key with NO separator is the pre-#1038 bare shape. It is dropped at the
  write boundary (`cast_muted_key/2`) and rewritten once, at migration time,
  by `20260808120000_prefix_muted_targets_with_network`.

  The value is the closed shape `%{"until" => unix_seconds | nil}`, string
  keys because that is what survives the `:map` JSON round-trip. `nil` is a
  permanent mute; an integer is a snooze. The field carries `until` from day
  one (vjt's Q1) even though no UI sets it yet, so adding a snooze picker
  later needs no second structure and no migration.

  Elapsed entries are dropped by the READER (`get_notification_prefs/1`),
  never by a sweeper and never by the predicate — see that function.
  """
  @type muted_targets :: %{String.t() => %{String.t() => pos_integer() | nil}}

  @typedoc """
  Per-subject notification preferences — push-notifications cluster B3.

  Three booleans + two string-list whitelists + one mute map (#866).
  Whitelist semantics: IF `channel_messages_all` is true the
  `channel_messages_only` list is ignored at trigger-eval time (UI greys
  it out, server still stores the value so toggling `_all` off restores
  the prior list). Same for `private_messages_all` /
  `private_messages_only`.

  `muted_targets` is the only DENY side and it OUTRANKS all of the above,
  a mention included (vjt's Q2) — see `t:muted_targets/0`.

  Channel names + nicks in the two WHITELISTS are stored folded + trimmed
  (set via `put_notification_prefs/2`) through
  `Identifier.canonical_target/1`, and trigger eval folds the incoming
  message fields the same way, so the comparison is case-insensitive
  end-to-end under CASEMAPPING=ascii. `muted_targets` folds the same way but
  its key also carries the network — `Identifier.channel_key/2`, #1038.
  """
  @type notification_prefs :: %{
          channel_messages_all: boolean(),
          channel_messages_only: [String.t()],
          channel_mentions: boolean(),
          private_messages_all: boolean(),
          private_messages_only: [String.t()],
          muted_targets: muted_targets()
        }

  @typedoc """
  Per-subject display preferences (#449) — server-backed so a single account
  converges its UI across devices.

    * `time_format` — `"hms"` (with seconds, the default) or `"hm"`.
    * `colored_nicklist` — per-nick colours in the members pane (default false).
    * `presence_filter` — per-channel join/part/quit visibility pins,
      `%{channel_key => "show" | "hide"}`. TRI-STATE: an unpinned channel is
      ABSENT (cic follows the live member-count default). The server never
      stores a third value and never coerces unset into a boolean. Font size
      is deliberately excluded — it is per-DEVICE (vjt, #449) and stays
      client-local (`cicchetto/src/lib/fontSize.ts`).
  """
  # `time_format` + the presence values are closed sets ("hms"|"hm",
  # "show"|"hide"), but they stay `String.t()` on PURPOSE: Elixir typespecs
  # have no string-literal type, and they must remain wire strings (JSON, the
  # `:map` round-trip, `String.to_atom/1` banned). Introducing atoms only here
  # would be half-migrated vs the sibling string-keyed wire types
  # (notification_prefs, aliases). The closed set is enforced at the boundary
  # by `@display_time_formats` / `@display_presence_values` + the changeset —
  # that IS the CLAUDE.md "reject unknown values at the boundary" contract.
  @type display_prefs :: %{
          time_format: String.t(),
          colored_nicklist: boolean(),
          presence_filter: %{String.t() => String.t()}
        }

  @notification_prefs_key "notification_prefs"
  @upload_ttl_seconds_key "upload_ttl_seconds"
  @vhost_selection_key "vhost_selection"
  @active_theme_id_key "active_theme_id"
  # #358 — the day/night pair's night slot. The `active_theme_id` key is the
  # day (light) slot; `dark_theme_id` is the optional night (dark) slot. A
  # `nil`/absent dark means "same theme both modes" (the #75 single pick).
  @dark_theme_id_key "dark_theme_id"
  # #385 — user-defined command aliases. A string→string map: alias name
  # (lowercased verb) → raw expansion template (`whois $1 $1`). Expansion +
  # builtin-collision precedence are client-side (cic owns DISPATCH); the
  # server validates only structural shape at this boundary.
  @aliases_key "aliases"

  # #449 — server-backed display preferences (timestamp format, colored
  # nicklist, per-channel presence filter). ONE JSON sub-object so a single
  # account converges its UI across devices. TRI-STATE presence pins
  # (show/hide/unset) MUST survive the round-trip: unset is the ABSENCE of a
  # channel key, never a third value, never a boolean. Font size is excluded
  # (per-DEVICE, vjt/#449) and stays client-local.
  @display_prefs_key "display_prefs"
  @display_time_formats ~w(hms hm)
  @display_presence_values ~w(show hide)

  # #543 — the subject's last-known client network prefix key, sampled at
  # client-connect and read at upstream-connect for the static_mapping
  # addressing mode. The value is an OPAQUE base16 string here (a raw
  # `client_key` binary is not JSON-safe); `Grappa.Vhosts` owns the
  # client_key/base16 domain logic — this module is a dumb string store,
  # mirroring the `vhost_selection` split.
  @last_client_prefix64_key "last_client_prefix64"

  # Structural bounds for aliases — a user-writable JSON blob needs a boundary
  # or it becomes an unbounded storage/DOS vector (same rationale as
  # @upload_ttl_seconds_max). Generous enough that no real config hits them.
  @alias_name_max_bytes 32
  @alias_expansion_max_bytes 512
  @aliases_max_count 200

  # Structural bounds for the #449 presence-filter map — a user-writable blob
  # needs a boundary (same rationale as @aliases_max_count / @upload_ttl_seconds_max).
  @presence_filter_max_count 2_000
  @channel_key_max_bytes 256

  # #866 — same rationale as @presence_filter_max_count: `muted_targets` is a
  # user-writable JSON blob, so it needs a ceiling or it is a storage vector.
  # Generous against reality — the picker only offers conversations the
  # subject actually has, and nobody is in 2000 of them.
  @muted_targets_max_count 2_000

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
  @spec get_or_init(Subject.t()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def get_or_init({_, _} = subject) do
    with :ok <- validate_subject_exists(subject) do
      attrs = Subject.put_subject_id(%{data: %{}}, subject)
      cs = Settings.changeset(%Settings{}, attrs)

      # #523 — ride out a transient SQLITE_BUSY on the row init; sustained
      # saturation degrades to `{:error, :db_unavailable}` → a clean 503 (#518)
      # at every PUT /me/settings setter (they all init through here first).
      insert_result =
        Repo.BusyRetry.run(fn ->
          Repo.insert(cs, on_conflict: :nothing, conflict_target: conflict_target(subject))
        end)

      case insert_result do
        {:ok, %Settings{id: nil}} ->
          fetch_existing(subject)

        {:ok, settings} ->
          {:ok, settings}

        {:error, :db_unavailable} = err ->
          err

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
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def set_highlight_patterns({_, _} = subject, patterns) when is_list(patterns) do
    with :ok <- validate_patterns(patterns, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, "highlight_patterns", patterns)
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
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
      private_messages_only: [],
      muted_targets: %{}
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

  ## Snooze expiry happens HERE (#866, vjt's Q3)

  A `muted_targets` entry whose `until` has elapsed is dropped from the
  returned map. This is the ONLY place a mute expires — there is no
  sweeper, and `Push.Triggers.should_notify?/5` never looks at the clock,
  which is what keeps it a PURE predicate and keeps the shared cic/Elixir
  truth-table free of a `now` column.

  Expiry is a READ-side projection, not a write: the stored row keeps the
  elapsed entry. It disappears from storage on the next
  `put_notification_prefs/2`, because the client PUTs back the map it read
  from here. That costs nothing and keeps this reader side-effect-free —
  pruning here would make a GET issue a write, and `Push.BadgeCount` calls
  this per badge recount.
  """
  @spec get_notification_prefs(Subject.t()) :: notification_prefs()
  def get_notification_prefs({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        default_notification_prefs()

      %Settings{data: data} ->
        case data[@notification_prefs_key] do
          %{} = stored -> stored |> merge_with_defaults() |> drop_elapsed_mutes()
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
    * `muted_targets` (#866) is the ONE key whose ABSENCE means "leave it
      alone" rather than "set it to empty". Every other key is
      full-replace, and that is still the contract for the five the
      endpoint shipped with. The exception exists because cic deploys
      independently of the BEAM and an installed PWA can run a cached
      bundle for weeks: a client that has never heard of `muted_targets`
      is saying nothing about the subject's mutes, not asserting they have
      none, and reading its silence as "clear them" would delete an
      operator's mutes the first time they tick any other checkbox. Keys
      are folded (`Identifier.canonical_target/1`) and `until` must be
      `null` or a positive unix timestamp in seconds.

  Returns `{:ok, %Settings{}}` on persistence; `{:error, changeset}`
  with descriptive errors on either validation failure path.
  """
  @spec put_notification_prefs(Subject.t(), notification_prefs()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_notification_prefs({_, _} = subject, prefs) when is_map(prefs) do
    with {:ok, normalized} <- validate_and_normalize_prefs(prefs, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @notification_prefs_key, stringify_prefs(normalized))
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
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
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_upload_ttl_seconds({_, _} = subject, seconds) do
    with :ok <- validate_upload_ttl_seconds(seconds, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data =
        case seconds do
          nil -> Map.delete(settings.data, @upload_ttl_seconds_key)
          n -> Map.put(settings.data, @upload_ttl_seconds_key, n)
        end

      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
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
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_vhost_selection({_, _} = subject, addresses) when is_list(addresses) do
    with :ok <- validate_vhost_selection(addresses, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @vhost_selection_key, addresses)
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
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
  # last_client_prefix64 accessor (#543 — dumb base16 string store)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the subject's last-known client prefix key as the RAW opaque
  base16 string, or `nil` when no row exists, the key is absent, or the
  stored value is malformed (not a non-empty binary).

  This is a dumb string store — decoding the base16 back to the raw
  `client_key` binary is `Grappa.Vhosts.last_client_prefix64/1`'s job.
  Side-effect-free; reads the string key (`:map` JSON round-trip).
  """
  @spec get_last_client_prefix64(Subject.t()) :: String.t() | nil
  def get_last_client_prefix64({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        nil

      %Settings{data: data} ->
        case data[@last_client_prefix64_key] do
          s when is_binary(s) and byte_size(s) > 0 -> s
          _ -> nil
        end
    end
  end

  @doc """
  Persists the subject's last-known client prefix key (an opaque base16
  string), preserving other keys in `data` (merge semantics). Validates
  the value is a non-empty base16 string; the client_key → base16
  encoding is `Grappa.Vhosts.record_client_source/2`'s responsibility.
  Last-write-wins (a roam replaces the stored key).
  """
  @spec put_last_client_prefix64(Subject.t(), String.t()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_last_client_prefix64({_, _} = subject, hex) when is_binary(hex) do
    with :ok <- validate_base16(hex, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @last_client_prefix64_key, hex)
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
    end
  end

  @spec validate_base16(String.t(), Subject.t()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_base16(hex, subject) do
    if byte_size(hex) > 0 and match?({:ok, _}, Base.decode16(hex)) do
      :ok
    else
      attrs = Subject.put_subject_id(%{data: %{}}, subject)

      cs =
        %Settings{}
        |> Settings.changeset(attrs)
        |> Ecto.Changeset.add_error(
          :last_client_prefix64,
          "must be a non-empty base16 string"
        )

      {:error, cs}
    end
  end

  # ---------------------------------------------------------------------------
  # active_theme_id accessor (#75 themes)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the subject's active (day/light) theme id, or `nil` when no row
  exists, the key is absent, or the stored value is malformed.

  `nil` means "no theme chosen" — the caller
  (`Grappa.Themes.get_active_theme_pair/1`) falls back to the client/default
  look. Reads with the string key (`:map` JSON round-trip).
  """
  @spec get_active_theme_id(Subject.t()) :: pos_integer() | nil
  def get_active_theme_id({_, _} = subject),
    do: get_theme_pointer(subject, @active_theme_id_key)

  @doc """
  Returns the subject's night (dark) theme id (#358), or `nil` when it is
  unset/malformed. `nil` means the day slot applies in both modes (the #75
  single-pick behaviour).
  """
  @spec get_dark_theme_id(Subject.t()) :: pos_integer() | nil
  def get_dark_theme_id({_, _} = subject),
    do: get_theme_pointer(subject, @dark_theme_id_key)

  # Shared reader for either theme-pointer JSON key — a positive integer or nil.
  @spec get_theme_pointer(Subject.t(), String.t()) :: pos_integer() | nil
  defp get_theme_pointer(subject, key) do
    case fetch_existing_or_nil(subject) do
      nil ->
        nil

      %Settings{data: data} ->
        case data[key] do
          n when is_integer(n) and n > 0 -> n
          _ -> nil
        end
    end
  end

  @doc """
  Atomically sets the day/night theme pair (#358) in ONE `data` update: the
  `active_theme_id` (light) key always to `light_id`, and the `dark_theme_id`
  key to `dark_id` (or deletes it when `nil`). A single write so a bad dark
  never leaves a half-applied pair. Validates both ids are `nil`/positive;
  confirming they reference readable themes is the caller's job
  (`Grappa.Themes.set_active_theme_pair/3`).
  """
  @spec put_theme_pair(Subject.t(), pos_integer(), pos_integer() | nil) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_theme_pair({_, _} = subject, light_id, dark_id) do
    with :ok <- validate_theme_pointer(light_id, subject, :active_theme_id),
         :ok <- validate_theme_pointer(dark_id, subject, :dark_theme_id),
         {:ok, settings} <- get_or_init(subject) do
      merged_data =
        settings.data
        |> put_or_delete(@active_theme_id_key, light_id)
        |> put_or_delete(@dark_theme_id_key, dark_id)

      persist(Settings.changeset(settings, %{data: merged_data}))
    end
  end

  # Merge helper: a positive id is stored, a nil clears the key.
  defp put_or_delete(data, key, nil), do: Map.delete(data, key)
  defp put_or_delete(data, key, id), do: Map.put(data, key, id)

  @spec validate_theme_pointer(term(), Subject.t(), atom()) :: :ok | {:error, Ecto.Changeset.t()}
  defp validate_theme_pointer(nil, _, _), do: :ok
  defp validate_theme_pointer(n, _, _) when is_integer(n) and n > 0, do: :ok

  defp validate_theme_pointer(_, subject, field) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    cs =
      %Settings{}
      |> Settings.changeset(attrs)
      |> Ecto.Changeset.add_error(field, "must be a positive integer or null")

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
  # aliases accessors (#385 user-defined command aliases)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the subject's user-defined command aliases as a
  `%{name => expansion}` map (both strings).

  Returns `%{}` when no row exists, the `"aliases"` key is absent, or the
  stored value is malformed (not a map). Non-`string => string` entries are
  filtered out defensively (a miscoded writer could leave a stray shape after
  a JSON round-trip). Side-effect-free — does NOT create the row.

  Reads with the string key `"aliases"` (Ecto `:map` decodes JSON with string
  keys after a DB round-trip).
  """
  @spec get_aliases(Subject.t()) :: %{String.t() => String.t()}
  def get_aliases({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        %{}

      %Settings{data: data} ->
        case data[@aliases_key] do
          %{} = stored -> sanitize_aliases_read(stored)
          _ -> %{}
        end
    end
  end

  @doc """
  Replaces the subject's alias map, preserving other keys in `data` (merge
  semantics, like `put_notification_prefs/2`). An empty map clears all aliases.

  ## Validation (structural — the boundary the server owns)

    * Every key AND value must be a string. Each name is trimmed +
      lowercased; each expansion trimmed.
    * A name must be non-empty, contain no whitespace (it is a command verb),
      and be at most #{@alias_name_max_bytes} bytes.
    * An expansion must be non-empty and at most #{@alias_expansion_max_bytes}
      bytes.
    * At most #{@aliases_max_count} aliases total.

  Expansion grammar (`$1..$9` / `$*` / implicit append), builtin-collision
  precedence, and recursion depth are enforced client-side (cic owns the
  DISPATCH table) — NOT here. Errors are added on the synthetic `:aliases`
  changeset field so they surface as `field_errors.aliases` in the 422
  envelope.
  """
  @spec set_aliases(Subject.t(), %{optional(String.t()) => term()}) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def set_aliases({_, _} = subject, aliases) when is_map(aliases) do
    with {:ok, normalized} <- validate_and_normalize_aliases(aliases, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @aliases_key, normalized)
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
    end
  end

  # ---------------------------------------------------------------------------
  # display_prefs accessors (#449 server-backed display preferences)
  # ---------------------------------------------------------------------------

  @doc """
  Default display preferences applied when a subject has no row OR the
  `"display_prefs"` key is absent: `"hms"` timestamps, monochrome nicklist,
  and an empty presence-filter map (every channel follows the size default).
  """
  @dialyzer {:nowarn_function, default_display_prefs: 0}
  @spec default_display_prefs() :: display_prefs()
  def default_display_prefs do
    %{time_format: "hms", colored_nicklist: false, presence_filter: %{}}
  end

  @doc """
  Returns the `display_prefs` map for `subject`, filling any missing key
  from `default_display_prefs/0` so the shape is always complete.

  Falls back to defaults when no row exists, the `"display_prefs"` key is
  absent, or the stored value is malformed. Side-effect-free; reads string
  keys (Ecto `:map` JSON round-trip). Defensively drops presence entries
  whose value is not `"show"`/`"hide"` — the tri-state never surfaces a
  third value to callers.
  """
  @spec get_display_prefs(Subject.t()) :: display_prefs()
  def get_display_prefs({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      nil ->
        default_display_prefs()

      %Settings{data: data} ->
        case data[@display_prefs_key] do
          %{} = stored -> merge_display_with_defaults(stored)
          _ -> default_display_prefs()
        end
    end
  end

  @doc """
  Whether `subject` has ever persisted a well-formed `display_prefs` blob.

  `get_display_prefs/1` always returns a complete shape from defaults, so the
  GET payload alone cannot tell "never written" from "written == defaults".
  The client's seed-up-once (#449 Fork B) needs that distinction: absent ⇒
  push the local values up (never clobber another device's config); present ⇒
  the server wins. This predicate is the explicit, additive signal the
  controller surfaces as `persisted` in the wire envelope.

  Mirrors `get_display_prefs/1`'s own map guard: a malformed (non-map) stored
  value counts as NOT persisted, so the client seeds up and the row self-heals.
  """
  @spec display_prefs_persisted?(Subject.t()) :: boolean()
  def display_prefs_persisted?({_, _} = subject) do
    case fetch_existing_or_nil(subject) do
      %Settings{data: data} -> is_map(data[@display_prefs_key])
      nil -> false
    end
  end

  @doc """
  Sets the `display_prefs` map for `subject`, preserving other `data` keys
  (merge semantics). Full-map replace of the `display_prefs` sub-object — no
  PATCH/diff (mirrors `put_notification_prefs/2`).

  ## Validation (errors on the synthetic `:display_prefs` field → 422)

    * `time_format` ∈ #{inspect(@display_time_formats)}.
    * `colored_nicklist` is a boolean.
    * `presence_filter` is a `%{channel_key => "show" | "hide"}` map. Any
      other value (a boolean, a third state) is REJECTED — the tri-state's
      unset is the ABSENCE of a key, never a stored value, so the server
      must never accept nor emit a flattened form.
    * Bounds: at most #{@presence_filter_max_count} pins, each key at most
      #{@channel_key_max_bytes} bytes (DOS guard, like `@aliases_max_count`).

  Accepts string- OR atom-keyed input (the wire is string-keyed); stores
  string keys so reads are stable across the JSON round-trip.
  """
  @spec put_display_prefs(Subject.t(), map()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def put_display_prefs({_, _} = subject, prefs) when is_map(prefs) do
    with {:ok, normalized} <- validate_and_normalize_display_prefs(prefs, subject),
         {:ok, settings} <- get_or_init(subject) do
      merged_data = Map.put(settings.data, @display_prefs_key, normalized)
      cs = Settings.changeset(settings, %{data: merged_data})
      persist(cs)
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # #523 — the single write choke point for every setter. Rides out a transient
  # SQLITE_BUSY on the `user_settings` UPDATE; sustained saturation degrades to
  # `{:error, :db_unavailable}` → a clean 503 (#518) at the PUT /me/settings
  # family instead of a 500 raise. `Repo.update/1` returns exactly the
  # `{:ok, _} | {:error, changeset}` shape `BusyRetry.run/1` expects.
  @spec persist(Ecto.Changeset.t()) ::
          {:ok, Settings.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  defp persist(cs), do: Repo.BusyRetry.run(fn -> Repo.update(cs) end)

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

    bools
    |> Map.merge(lists)
    |> Map.put(:muted_targets, read_muted_targets(stored))
  end

  # #866 — defensive read of the mute map, the twin of `sanitize_aliases_read/1`.
  # A row written by a future (or miscoded) writer must not reach the predicate
  # half-shaped: an entry survives only with a non-empty binary key and a value
  # that yields a usable `until`, and it is rebuilt into EXACTLY
  # `%{"until" => v}` so no stray sibling key rides along. Keys are NOT re-folded
  # — they were folded at write, which is the channel pattern.
  @spec read_muted_targets(map()) :: muted_targets()
  defp read_muted_targets(stored) do
    case Map.get(stored, :muted_targets, Map.get(stored, "muted_targets")) do
      map when is_map(map) -> sanitize_muted_read(map)
      _ -> %{}
    end
  end

  defp sanitize_muted_read(map) do
    map
    |> Enum.flat_map(fn {key, value} ->
      case {is_binary(key) and key != "", read_until(value)} do
        {true, {:ok, until}} -> [{key, %{"until" => until}}]
        _ -> []
      end
    end)
    |> Map.new()
  end

  # `nil`/absent is a PERMANENT mute, not a malformed one. Anything else that
  # is not a positive integer is malformed and drops the whole entry —
  # failing OPEN (the conversation notifies) rather than silencing forever on
  # a value nobody can interpret.
  defp read_until(value) when is_map(value) do
    case Map.get(value, "until", Map.get(value, :until)) do
      nil -> {:ok, nil}
      n when is_integer(n) and n > 0 -> {:ok, n}
      _ -> :error
    end
  end

  defp read_until(_), do: :error

  # #866 Q3 — the ONE place a snooze expires. Read-side only: see
  # `get_notification_prefs/1`'s doc for why this is not a write and not a
  # sweeper.
  @spec drop_elapsed_mutes(notification_prefs()) :: notification_prefs()
  defp drop_elapsed_mutes(prefs) do
    now = System.os_time(:second)

    Map.update!(prefs, :muted_targets, fn muted ->
      # Every value is `%{"until" => nil | pos_integer}` by construction —
      # `sanitize_muted_read/1` dropped anything else — so this match is total.
      Map.filter(muted, fn {_, %{"until" => until}} -> is_nil(until) or until > now end)
    end)
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
         {:ok, muted} <- cast_muted_targets(prefs, subject),
         normalized =
           bools |> Map.merge(lists) |> Map.put(:muted_targets, resolve_muted(muted, subject)),
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
  # occurrence. The fold is identity-key-correct per list type (ASCII,
  # #121/#525): `private_messages_only` is a nick list → canonical_nick/1
  # (CASEMAPPING=ascii — folds `A-Z` ONLY); `channel_messages_only` is a
  # channel list → canonical_channel/1 (sigil-gated ASCII fold, #364/#525 —
  # folds `A-Z` like nicks, brackets `[ ] \ ~` left UNTOUCHED so
  # foo[bar]/foo{bar} stay DISTINCT). A bare String.downcase is wrong not
  # for the brackets but because it Unicode-over-folds non-ASCII (e.g.
  # #CAFÉ/#café), diverging from the ASCII fold the stored list + the
  # folded sender in Triggers.sender_in_whitelist?/2 use.
  defp normalize_list(list, key) do
    fold = list_fold(key)

    list
    |> Enum.map(&(&1 |> String.trim() |> fold.()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  # #537 — both lists fold via `canonical_target/1` (the fold at every
  # identifier boundary). `channel_messages_only` was sigil-gated
  # (`canonical_channel/1`), so a nick-shaped entry stayed raw and its
  # membership test (`Triggers.channel_in_whitelist?/2`) stopped applying
  # after a case-different re-open. `canonical_target` folds channels and
  # nicks identically (sigils sit outside A-Z), so this is byte-identical
  # for real channels and corrective for a nick-shaped key.
  defp list_fold(:private_messages_only), do: &Identifier.canonical_target/1
  defp list_fold(:channel_messages_only), do: &Identifier.canonical_target/1

  # #866 — the one key whose ABSENCE means "unchanged" rather than "empty".
  # See `put_notification_prefs/2`'s doc: a cic bundle older than this BEAM is
  # not asserting the subject has no mutes, and clearing them on its first
  # checkbox save would be silent data loss during any rollout window. An
  # explicit `null` reads the same as absent — a client that means "clear
  # them" sends `{}`, which is a map and takes the normalize path.
  defp cast_muted_targets(prefs, subject) do
    case Map.get(prefs, :muted_targets, Map.get(prefs, "muted_targets")) do
      nil -> {:ok, :unchanged}
      map when is_map(map) -> normalize_muted_targets(map, subject)
      _ -> {:error, prefs_changeset_error("muted_targets must be a map", subject)}
    end
  end

  # Resolving :unchanged costs one extra SELECT, and only on the absent path.
  # It reads through `get_notification_prefs/1` ON PURPOSE rather than off the
  # raw column: that reader is also where snoozes expire, so an old client's
  # save prunes elapsed entries as a side effect instead of writing them back.
  defp resolve_muted(:unchanged, subject),
    do: Map.fetch!(get_notification_prefs(subject), :muted_targets)

  defp resolve_muted(muted, _) when is_map(muted), do: muted

  defp normalize_muted_targets(map, subject) when map_size(map) > @muted_targets_max_count do
    {:error,
     prefs_changeset_error(
       "muted_targets must have at most #{@muted_targets_max_count} entries",
       subject
     )}
  end

  defp normalize_muted_targets(map, subject), do: collect_muted(Map.to_list(map), %{}, subject)

  # Collect-or-bail traversal per CLAUDE.md: success extends the accumulator,
  # the first error returns immediately. Two raw keys that fold to the same
  # composite collapse onto one entry, last one wins — the same collision the
  # picker prevents client-side by deduping before it offers the option.
  #
  # `:drop` is a THIRD outcome, and only the KEY SHAPE produces it: the entry
  # is skipped and the traversal continues. See `cast_muted_key/2`.
  defp collect_muted([], acc, _), do: {:ok, acc}

  defp collect_muted([{key, value} | rest], acc, subject) do
    case cast_muted_key(key, subject) do
      {:ok, composite} ->
        with {:ok, target} <- cast_muted_value(value, subject) do
          collect_muted(rest, Map.put(acc, composite, target), subject)
        end

      :drop ->
        # The value is deliberately NOT validated on this arm — a dropped key
        # carries no entry, so there is nothing for a malformed `until` to
        # corrupt, and validating it would fail the whole PUT for a mute that
        # is being discarded anyway.
        collect_muted(rest, acc, subject)

      {:error, _} = err ->
        err
    end
  end

  # #1038 — the key is the composite `ChannelKey` (`"<slug> <folded target>"`),
  # built by the cross-stack SSOT `Identifier.channel_key/2`. Decomposing and
  # REBUILDING through that function (rather than folding the string in place)
  # is what guarantees the stored key is byte-identical to the one
  # `Triggers.muted?/4` composes from an incoming row and the one cic's
  # `channelKey` emits.
  #
  # A key with no separator is the BARE pre-#1038 shape — a mute written by a
  # cic bundle older than this BEAM. It is DROPPED, and the rest of the PUT
  # proceeds. The three postures were weighed:
  #
  #   * failing the request would break the tolerant contract this module
  #     already keeps for an ABSENT `muted_targets` (see
  #     `cast_muted_targets/2`) and would stop an old bundle from saving ANY
  #     notification setting — the noise landing on the wrong person;
  #   * storing it verbatim would recreate the exact defect #1038 removes: a
  #     settings row that reads as muted and silences nothing, because no
  #     lookup ever builds that string;
  #   * expanding it to a network here would be the LAZY migration vjt
  #     explicitly ruled against (the rewrite runs ONCE, in the migration).
  #
  # Dropping is also the posture that already existed for this exact shape:
  # `PresenceFilter.Resolver.parse_pins/1` has ignored separator-less pins
  # since presence pins shipped ("not a ChannelKey ... dropped rather than
  # guessed at"). Same key, same rule, one implementation
  # (`Identifier.decode_channel_key/1`).
  #
  # An over-long key still ERRORS: that guard bounds a user-writable blob, and
  # silently discarding an abusive key would make the bound unobservable.
  @spec cast_muted_key(term(), Subject.t()) ::
          {:ok, String.t()} | :drop | {:error, Ecto.Changeset.t()}
  defp cast_muted_key(key, subject) when is_binary(key) do
    with {:ok, {slug, target}} <- Identifier.decode_channel_key(String.trim(key)),
         composite = Identifier.channel_key(slug, target),
         false <- byte_size(composite) > @channel_key_max_bytes do
      {:ok, composite}
    else
      :error ->
        :drop

      true ->
        {:error,
         prefs_changeset_error(
           "muted_targets keys must be at most #{@channel_key_max_bytes} bytes",
           subject
         )}
    end
  end

  defp cast_muted_key(_, subject),
    do: {:error, prefs_changeset_error("muted_targets keys must be strings", subject)}

  # Rebuilt into EXACTLY `%{"until" => v}` — a sibling key the writer invented
  # is dropped here rather than persisted into a shape the readers don't model.
  defp cast_muted_value(value, subject) when is_map(value) do
    case Map.get(value, "until", Map.get(value, :until)) do
      nil ->
        {:ok, %{"until" => nil}}

      n when is_integer(n) and n > 0 ->
        {:ok, %{"until" => n}}

      _ ->
        {:error,
         prefs_changeset_error(
           "muted_targets until must be null or a positive unix timestamp in seconds",
           subject
         )}
    end
  end

  defp cast_muted_value(_, subject),
    do: {:error, prefs_changeset_error("muted_targets values must be maps", subject)}

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

  # ---------------------------------------------------------------------------
  # aliases helpers (#385)
  # ---------------------------------------------------------------------------

  # Defensive read: keep only string => string entries. A JSON round-trip
  # gives string keys; a stray non-string value (miscoded writer) is dropped
  # rather than surfaced to callers.
  @spec sanitize_aliases_read(map()) :: %{String.t() => String.t()}
  defp sanitize_aliases_read(stored) do
    stored
    |> Enum.filter(fn {k, v} -> is_binary(k) and is_binary(v) end)
    |> Map.new()
  end

  @spec validate_and_normalize_aliases(map(), Subject.t()) ::
          {:ok, %{String.t() => String.t()}} | {:error, Ecto.Changeset.t()}
  defp validate_and_normalize_aliases(aliases, subject) do
    entries = Map.to_list(aliases)

    if length(entries) > @aliases_max_count do
      {:error, aliases_changeset_error("too many aliases (max #{@aliases_max_count})", subject)}
    else
      normalize_alias_entries(entries, subject)
    end
  end

  @spec normalize_alias_entries([{term(), term()}], Subject.t()) ::
          {:ok, %{String.t() => String.t()}} | {:error, Ecto.Changeset.t()}
  defp normalize_alias_entries(entries, subject),
    do: normalize_alias_entries(entries, %{}, subject)

  defp normalize_alias_entries([], acc, _), do: {:ok, acc}

  defp normalize_alias_entries([{name, expansion} | rest], acc, subject) do
    case normalize_alias_entry(name, expansion) do
      {:ok, {n, e}} -> normalize_alias_entries(rest, Map.put(acc, n, e), subject)
      {:error, reason} -> {:error, aliases_changeset_error(reason, subject)}
    end
  end

  @spec normalize_alias_entry(term(), term()) ::
          {:ok, {String.t(), String.t()}} | {:error, String.t()}
  defp normalize_alias_entry(name, expansion) when is_binary(name) and is_binary(expansion) do
    n = name |> String.trim() |> String.downcase()
    e = String.trim(expansion)

    cond do
      n == "" ->
        {:error, "alias name must not be empty"}

      String.match?(n, ~r/\s/u) ->
        {:error, "alias name must not contain whitespace"}

      byte_size(n) > @alias_name_max_bytes ->
        {:error, "alias name too long (max #{@alias_name_max_bytes} bytes)"}

      e == "" ->
        {:error, "alias expansion must not be empty"}

      byte_size(e) > @alias_expansion_max_bytes ->
        {:error, "alias expansion too long (max #{@alias_expansion_max_bytes} bytes)"}

      true ->
        {:ok, {n, e}}
    end
  end

  defp normalize_alias_entry(_, _), do: {:error, "alias name and expansion must be strings"}

  defp aliases_changeset_error(message, subject) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    %Settings{}
    |> Settings.changeset(attrs)
    |> Ecto.Changeset.add_error(:aliases, message)
  end

  # ---------------------------------------------------------------------------
  # display_prefs helpers (#449)
  # ---------------------------------------------------------------------------

  # Read an atom-or-string key. Post-DB round-trip is string-keyed; a fresh
  # atom-keyed in-memory map is possible from a test writer or an atom-keyed
  # caller — mirror of the notification helpers' dual read.
  defp display_fetch(prefs, key) when is_atom(key) do
    Map.get(prefs, key, Map.get(prefs, Atom.to_string(key)))
  end

  # Fill each key from defaults; drop malformed presence entries so a caller
  # never sees a third tri-state value (unset stays absent).
  @spec merge_display_with_defaults(map()) :: display_prefs()
  defp merge_display_with_defaults(stored) do
    %{
      time_format: read_display_time_format(stored),
      colored_nicklist: read_display_bool(stored, :colored_nicklist, false),
      presence_filter: read_presence_filter(stored)
    }
  end

  defp read_display_time_format(stored) do
    case display_fetch(stored, :time_format) do
      v when v in @display_time_formats -> v
      _ -> "hms"
    end
  end

  defp read_display_bool(stored, key, default) do
    case display_fetch(stored, key) do
      v when is_boolean(v) -> v
      _ -> default
    end
  end

  defp read_presence_filter(stored) do
    case display_fetch(stored, :presence_filter) do
      %{} = pf ->
        pf
        |> Enum.filter(fn {k, v} -> is_binary(k) and v in @display_presence_values end)
        |> Map.new()

      _ ->
        %{}
    end
  end

  @spec validate_and_normalize_display_prefs(map(), Subject.t()) ::
          {:ok, %{String.t() => term()}} | {:error, Ecto.Changeset.t()}
  defp validate_and_normalize_display_prefs(prefs, subject) do
    with {:ok, tf} <- fetch_display_time_format(prefs),
         {:ok, cn} <- fetch_display_bool(prefs, :colored_nicklist),
         {:ok, pf} <- fetch_presence_filter(prefs) do
      {:ok, %{"time_format" => tf, "colored_nicklist" => cn, "presence_filter" => pf}}
    else
      {:error, message} -> {:error, display_prefs_changeset_error(message, subject)}
    end
  end

  defp fetch_display_time_format(prefs) do
    case display_fetch(prefs, :time_format) do
      v when v in @display_time_formats -> {:ok, v}
      _ -> {:error, "time_format must be one of #{inspect(@display_time_formats)}"}
    end
  end

  defp fetch_display_bool(prefs, key) when is_atom(key) do
    case display_fetch(prefs, key) do
      v when is_boolean(v) -> {:ok, v}
      _ -> {:error, "#{key} must be a boolean"}
    end
  end

  defp fetch_presence_filter(prefs) do
    case display_fetch(prefs, :presence_filter) do
      %{} = pf -> normalize_presence_filter(pf)
      _ -> {:error, "presence_filter must be a map"}
    end
  end

  defp normalize_presence_filter(pf) do
    entries = Map.to_list(pf)

    if length(entries) > @presence_filter_max_count do
      {:error, "too many presence pins (max #{@presence_filter_max_count})"}
    else
      validate_presence_entries(entries, %{})
    end
  end

  # Collect-or-bail recursion (CLAUDE.md prefers this over reduce_while).
  defp validate_presence_entries([], acc), do: {:ok, acc}

  defp validate_presence_entries([{key, value} | rest], acc) do
    cond do
      not (is_binary(key) and byte_size(key) > 0) ->
        {:error, "presence_filter keys must be non-empty strings"}

      byte_size(key) > @channel_key_max_bytes ->
        {:error, "presence_filter key too long (max #{@channel_key_max_bytes} bytes)"}

      value not in @display_presence_values ->
        {:error, ~s(presence_filter values must be "show" or "hide")}

      true ->
        validate_presence_entries(rest, Map.put(acc, key, value))
    end
  end

  defp display_prefs_changeset_error(message, subject) do
    attrs = Subject.put_subject_id(%{data: %{}}, subject)

    %Settings{}
    |> Settings.changeset(attrs)
    |> Ecto.Changeset.add_error(:display_prefs, message)
  end
end
