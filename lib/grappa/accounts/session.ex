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
      deployment posture (see Decision A).

  ## Lifecycle

    * `created_at` is set once at `Accounts.create_session/4` and
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

  ## Two kinds (GH #1196)

  `kind` splits the table into the browser bearer (`:web`, the default
  and everything that existed before) and the per-client token
  (`:client`). A client token is the same primitive — a row whose `:id`
  is the bearer — with three differences, and `kind` is what each of
  them reads:

    * **No idle expiry.** `Accounts.authenticate/1` never ages a
      `:client` row out, and `Accounts.delete_expired_sessions/0` never
      sweeps one. A headless client that was offline a fortnight comes
      back to a working token; revocation is the intended kill switch.
    * **A restricted scope.** `GrappaWeb.Plugs.RequireFullSession`
      refuses the account's own credential-management surfaces to a
      `:client` bearer, so a leaked token can read and send messages
      but cannot become the account.
    * **A label**, so the device list is readable. Required on a
      `:client` row, refused on a `:web` one.

  `kind` is a column rather than `label != nil` on purpose: the scope
  and lifecycle rules must key off a field that MEANS "restricted,
  non-expiring". Deriving them from the nullness of a display string
  would let a later "name your browser session" feature flip the
  security boundary by accident.

  The `:id` of a client token is still the secret, so it must never be
  listed back — `handle/1` is the public, one-way name a device list
  and an operator log line use instead.
  """
  # `Grappa.Subject` is the one declared dep, and unlike the `belongs_to`
  # metadata this module's other names arrive as, it is a real call the
  # checker resolves: `changeset/2` pipes through `Subject.validate_xor/1`
  # (#1580). No cycle — `Grappa.Subject` depends on `Accounts.User` and
  # `Visitors.Visitor`, neither of which reaches back here.
  use Boundary, top_level?: true, deps: [Grappa.Subject]

  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @typedoc """
  Which door minted the row, and therefore which lifecycle + scope it
  obeys. `:web` is the browser bearer; `:client` is the #1196 per-client
  token.
  """
  @type kind :: :web | :client

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          created_at: DateTime.t() | nil,
          last_seen_at: DateTime.t() | nil,
          revoked_at: DateTime.t() | nil,
          user_agent: String.t() | nil,
          ip: String.t() | nil,
          client_id: Grappa.ClientId.t() | nil,
          kind: kind() | nil,
          label: String.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "sessions" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id

    field :created_at, :utc_datetime_usec
    field :last_seen_at, :utc_datetime_usec
    field :revoked_at, :utc_datetime_usec
    field :user_agent, :string
    field :ip, :string
    field :client_id, Grappa.ClientId
    field :kind, Ecto.Enum, values: [:web, :client], default: :web
    field :label, :string
  end

  @cast_fields [
    :user_id,
    :visitor_id,
    :created_at,
    :last_seen_at,
    :ip,
    :user_agent,
    :client_id,
    :kind,
    :label
  ]
  @required_fields [:created_at, :last_seen_at]

  @label_max_length 64
  # A label is rendered in a device list and in an operator's terminal.
  # C0 / DEL / C1 are never legitimate there and would corrupt both.
  @label_printable ~r/\A[^\x{0000}-\x{001F}\x{007F}-\x{009F}]+\z/u

  @doc """
  Changeset for inserting a new session row.

  Validates that `created_at` and `last_seen_at` are present (the
  other fields — `ip`, `user_agent` — are optional; mix-task callers
  have neither). Exactly one of `user_id` / `visitor_id` must be set —
  the XOR constraint is enforced by `Grappa.Subject.validate_xor/1` and at
  the DB level (CHECK constraint `sessions_subject_xor`).

  `assoc_constraint(:user)` and `assoc_constraint(:visitor)` are
  forward-compat hooks: PostgreSQL + MySQL surface FK violations with
  the constraint name attached so Ecto can map them to
  `{:user, "does not exist"}` / `{:visitor, "does not exist"}`.
  `ecto_sqlite3` returns the constraint name as `nil` (sqlite quirk),
  so the built-in handler can't match — the actual stale-FK guard for
  Grappa lives at `Accounts.create_session/4`'s
  `validate_subject_exists/1` pre-flight (S29 H4 + review-fix #5).
  Both constraints are kept here so a future PostgreSQL swap doesn't
  silently lose FK validation on either subject side.

  S29 H4: prior to this changeset, `Accounts.create_session/4` used
  `Ecto.Changeset.change/2` (no validation) and let the DB layer
  catch FK violations as raw exceptions, contradicting the function's
  `@spec :: ... | {:error, Ecto.Changeset.t()}`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(session, attrs) do
    session
    |> cast(attrs, @cast_fields)
    |> validate_required(@required_fields)
    |> Subject.validate_xor()
    |> validate_label_matches_kind()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
  end

  @doc """
  The public, one-way name of a session row (GH #1196).

  The bearer token IS `:id`, so `:id` may never be listed back to the
  caller or written to a log. This truncated SHA-256 digest is the
  stable handle that stands in for it: it correlates an operator log
  line (`session_ref:`) with a row in the caller's own device list, and
  it is what `DELETE /me/client-tokens/:handle` addresses — so revoking
  a token never requires re-presenting the secret.

  12 hex chars (48 bits) disambiguates every session an account will
  ever hold concurrently; reversing it would mean brute-forcing the
  122-bit UUID space. S9 introduced this digest for the log line; #1196
  promoted it to the schema so the log and the wire cannot drift into
  two different names for one row.
  """
  @spec handle(t() | Ecto.UUID.t()) :: String.t()
  def handle(%__MODULE__{id: id}) when is_binary(id), do: handle(id)

  def handle(id) when is_binary(id) do
    digest = :crypto.hash(:sha256, id)
    binary_part(Base.encode16(digest, case: :lower), 0, 12)
  end

  # A label is the readable name of a client token, so a `:client` row
  # without one is an unreadable device list. A `:web` row with one is
  # the inverse hazard: `kind` (not label-nullness) is the security
  # discriminator precisely BECAUSE the two must not be confusable, and
  # letting a browser session carry a label starts the confusion.
  @spec validate_label_matches_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_label_matches_kind(changeset) do
    case get_field(changeset, :kind) do
      :client ->
        changeset
        |> update_change(:label, &String.trim/1)
        |> validate_required([:label])
        |> validate_length(:label, max: @label_max_length)
        |> validate_format(:label, @label_printable, message: "must not contain control characters")

      _ ->
        if get_field(changeset, :label) do
          add_error(changeset, :label, "is only valid on a client token")
        else
          changeset
        end
    end
  end

  @doc """
  Builds a sliding-touch changeset that bumps `last_seen_at` to `now`,
  enforcing time-monotonicity (B5.4 L-pers-3).

  Pre-B5.4 the bump went through `Ecto.Changeset.change/2` directly,
  with no validation that `now > prev`. A system-clock skew (NTP
  step, container reboot, test fixture seeding `last_seen_at` from a
  fixed past) could move the column backward, which then caused the
  idle-timer in `Accounts.authenticate/1` to misjudge how long the
  session had been idle (`DateTime.diff(now, last_seen_at)` becomes
  negative or wildly large).

  The validator REJECTS strictly-backward bumps (`now < prev`); equal
  is admitted because a tight touch loop under high load can
  reasonably observe `now == prev` at usec resolution.

  `Accounts.touch_session/2` swallows the error path with a
  `Logger.warning` since the API contract returns a `Session.t()`
  (not `{:ok, _} | {:error, _}`). Production callers should never
  observe this failure mode — a backward clock is an operator-side
  infrastructure problem the bouncer can't recover from inline.
  """
  @spec touch_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def touch_changeset(%__MODULE__{last_seen_at: prev} = session, %DateTime{} = now) do
    cs = change(session, last_seen_at: now)

    case DateTime.compare(now, prev) do
      :lt -> add_error(cs, :last_seen_at, "must not move backward (system-clock skew?)")
      _ -> cs
    end
  end
end
