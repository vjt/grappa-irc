defmodule Grappa.UserSettings.Settings do
  @moduledoc """
  Schema for `user_settings` — one row per user, storing a JSON blob of
  per-user preferences.

  Public API lives in `Grappa.UserSettings`; callers receive `%Settings{}`
  structs by type and reference the schema only via the parent context.
  The Boundary annotation on `Grappa.UserSettings` exports this module
  so the `t()` cross-module reference resolves cleanly in published docs.

  ## Why JSON column (`data :: :map`)

  Per-user settings span many small orthogonal concerns (highlight watchlist,
  future UI toggles, notification thresholds). Storing them in individual
  columns requires an ALTER TABLE migration per new setting — expensive in
  SQLite (often a full table rebuild). An EAV per-key table forces N joins
  per settings read and loses type information. A single `:map` JSON column
  gives one-row-per-user, one-fetch reads, and forward-compat for new keys
  without per-key migrations.

  ## Schema-level vs accessor-level enforcement

  The `data` map shape is NOT enforced at the schema level. `changeset/2`
  validates only that `data` is castable to a map; per-key shape rules
  (types, ranges, allowed values) live in typed accessor functions on
  `Grappa.UserSettings`. This keeps the migration schema stable while
  letting the application layer tighten or evolve key contracts.

  ## Known key registry

  The following keys are reserved in `data`. Future additions MUST be
  documented here to avoid collisions:

  | Key                   | Type                                | Owner context                |
  |-----------------------|-------------------------------------|------------------------------|
  | `"highlight_patterns"` | `list(String.t())`                 | `Grappa.UserSettings` (S2.2) |
  | `"notification_prefs"` | `Grappa.UserSettings.notification_prefs()` | `Grappa.UserSettings` (B3) |
  | `"upload_ttl_seconds"` | `pos_integer() \\| nil`           | `Grappa.UserSettings` (UX-4 M) |
  | `"vhost_selection"`    | `list(String.t())`                  | `Grappa.Vhosts` (#228)       |

  ## String-key invariant (IMPORTANT)

  Ecto encodes `:map` fields via Jason before storage and decodes them on
  read. Jason encodes atom-keyed maps as JSON with string keys; on decode
  the keys come back as strings. This means:

  - `%{highlight_patterns: ["foo"]}` written via a changeset comes back as
    `%{"highlight_patterns" => ["foo"]}` after a DB round-trip.
  - ALL code that reads `data` from a fetched `%Settings{}` MUST use string
    keys, never atom keys. The `Grappa.UserSettings` accessor functions
    enforce this convention.

  Writing with either string or atom keys is equivalent (Jason handles both),
  but reading after a round-trip ALWAYS yields string keys.

  ## See also

  `Grappa.UserSettings` for the upsert / typed-accessor semantics.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          data: %{optional(String.t()) => term()},
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "user_settings" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id

    # JSON blob for all per-subject preference keys. Default %{} at the
    # schema layer; the DB DEFAULT is also '{}' (see migration). Ecto
    # handles JSON encode/decode via Jason. Read with string keys after
    # DB round-trip.
    field :data, :map, default: %{}

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert/update changeset.

  Subject XOR is required (`validate_subject_xor/1` attaches errors
  to the synthetic `:subject` key); `:data` is required at cast
  time. Shape validation of individual `data` keys is intentionally
  NOT performed here — that is the responsibility of typed accessor
  functions in `Grappa.UserSettings`. The schema-level changeset
  stays generic so it can be reused by all accessors without
  coupling it to any specific key's rules.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(settings, attrs) do
    settings
    |> cast(attrs, [:user_id, :visitor_id, :data])
    |> validate_required([:data])
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint(:user_id, name: :user_settings_user_id_index)
    |> unique_constraint(:visitor_id, name: :user_settings_visitor_id_index)
    |> check_constraint(:subject,
      name: :user_settings_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # Mirror of `Grappa.ReadCursor.Cursor.validate_subject_xor/1`.
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end
end
