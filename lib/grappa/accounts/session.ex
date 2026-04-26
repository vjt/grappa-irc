defmodule Grappa.Accounts.Session do
  @moduledoc """
  Bearer-token-bearing authentication session.

  ## Token == primary key

  The session's `:id` (UUID v4, binary_id PK) IS the bearer token. We
  don't store a separate `token_hash` column because:

    * UUID v4 has 122 bits of randomness — comfortably above the
      ~80-bit floor for an opaque bearer token.
    * The DB-side primary key already provides the lookup index "for
      free", and the secret never leaves the user's client + the row.
    * Hashing would buy us "leak the DB → can't use the tokens" but
      a DB leak in this app would already disclose the encrypted
      NickServ creds, scrollback, and channel topology — the marginal
      value of token-hashing on top is low for the operator-personal
      deployment posture (see `docs/plans/2026-04-25-phase2-auth.md`,
      Decision A).

  ## Lifecycle

    * `created_at` is set once at `Accounts.create_session/3` and
      never moves. `inserted_at`/`updated_at` are intentionally absent
      — the `last_seen_at` field is the only thing the sliding idle
      policy looks at, so a separate `updated_at` would just be a
      second clock that disagrees.
    * `last_seen_at` is bumped by `Accounts.authenticate/1`, but only
      when ≥ 60 s have passed since the previous bump, to avoid a
      DB-write per request under sustained traffic.
    * `revoked_at` is set by `Accounts.revoke_session/1` and is the
      only way to invalidate a session before its 7-day idle window
      elapses. Revoked sessions are kept (not deleted) so audit /
      housekeeping can see them; the Phase 5 cron does the actual GC.
  """
  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.Accounts.User

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          created_at: DateTime.t() | nil,
          last_seen_at: DateTime.t() | nil,
          revoked_at: DateTime.t() | nil,
          user_agent: String.t() | nil,
          ip: String.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "sessions" do
    belongs_to :user, User, type: :binary_id

    field :created_at, :utc_datetime_usec
    field :last_seen_at, :utc_datetime_usec
    field :revoked_at, :utc_datetime_usec
    field :user_agent, :string
    field :ip, :string
  end

  @cast_fields [:user_id, :created_at, :last_seen_at, :ip, :user_agent]
  @required_fields [:user_id, :created_at, :last_seen_at]

  @doc """
  Changeset for inserting a new session row.

  Validates that `user_id`, `created_at`, and `last_seen_at` are
  present (the other fields — `ip`, `user_agent` — are optional;
  mix-task callers have neither).

  `assoc_constraint(:user)` is a forward-compat hook: PostgreSQL +
  MySQL surface FK violations with the constraint name attached so
  Ecto can map them to `{:user, "does not exist"}`. `ecto_sqlite3`
  returns the constraint name as `nil` (sqlite quirk), so the
  built-in handler can't match — the actual stale-FK guard for
  Grappa lives at `Accounts.create_session/3`'s `validate_user_exists/1`
  pre-flight (S29 H4 + review-fix #5). Kept here so a future
  PostgreSQL swap doesn't silently lose the FK validation.

  S29 H4: prior to this changeset, `Accounts.create_session/3` used
  `Ecto.Changeset.change/2` (no validation) and let the DB layer
  catch FK violations as raw exceptions, contradicting the function's
  `@spec :: ... | {:error, Ecto.Changeset.t()}`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(session, attrs) do
    session
    |> cast(attrs, @cast_fields)
    |> validate_required(@required_fields)
    |> assoc_constraint(:user)
  end
end
