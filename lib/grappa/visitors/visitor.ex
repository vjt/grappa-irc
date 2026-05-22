defmodule Grappa.Visitors.Visitor do
  @moduledoc """
  Self-service visitor — collapsed shape for both anon and
  NickServ-as-IDP modes per cluster/visitor-auth.

  ## Lifecycle
  - Created on first `POST /auth/login` with a non-`@` identifier.
  - `password_encrypted` nil = anon (no NickServ password ever observed
    via +r MODE).
  - `password_encrypted` non-nil = NickServ-identified — the password
    was atomically committed after grappa observed +r MODE on the
    visitor's nick (see `Grappa.Visitors.commit_password/2`).
  - `expires_at` slides on user-initiated REST/WS verbs (≥1h cadence)
    while the visitor is anon. V7: `commit_password/2` clears
    `expires_at` to NULL — NickServ-identified visitors persist
    forever, removed only via operator `Visitors.delete/1`.
  - Reaped by `Grappa.Visitors.Reaper` when
    `expires_at IS NOT NULL AND expires_at <= now()`. CASCADE wipes
    related rows in `visitor_channels`, `messages`,
    `accounts_sessions`.

  ## Per-row network pinning
  `network_slug` is fixed at row creation. A config rotation
  (`GRAPPA_VISITOR_NETWORK` change) renders existing rows orphans —
  `Grappa.Bootstrap` hard-errors with operator instructions to run
  `mix grappa.reap_visitors --network=<old_slug>`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.EncryptedBinary
  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.VisitorChannel

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          nick: String.t() | nil,
          network_slug: String.t() | nil,
          password_encrypted: binary() | nil,
          expires_at: DateTime.t() | nil,
          ip: String.t() | nil,
          channels: [VisitorChannel.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitors" do
    field :nick, :string
    field :network_slug, :string
    field :password_encrypted, EncryptedBinary, redact: true
    field :expires_at, :utc_datetime_usec
    field :ip, :string

    has_many :channels, VisitorChannel, foreign_key: :visitor_id

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an anon-visitor create changeset. Required fields: `:nick`,
  `:network_slug`, `:expires_at`. `:ip` is optional. Validates `:nick`
  against `Identifier.valid_nick?/1` and `:network_slug` against
  `Identifier.valid_network_slug?/1` — both are wire-bound (PubSub
  topics + IRC handshake), so syntactic hygiene is enforced at the
  boundary. Uniqueness on `(nick, network_slug)` per W2.

  `:expires_at` must be strictly in the future (B5.4 M-pers-3): a row
  born already-expired would be reaped on the next `Reaper` sweep but
  in the meantime would consume `(nick, network_slug)` uniqueness and
  shadow a legitimate concurrent registration. The `validate_change`
  only fires when `:expires_at` is present (`validate_required` runs
  first), so a missing field surfaces a single "can't be blank" error
  rather than an additional confusing "must be in the future" against
  `nil`.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:nick, :network_slug, :expires_at, :ip])
    |> validate_required([:nick, :network_slug, :expires_at])
    |> validate_change(:nick, &validate_nick/2)
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> validate_change(:expires_at, &validate_future_expires_at/2)
    |> unique_constraint([:nick, :network_slug])
  end

  @doc """
  Atomically commit a NickServ password (encrypted at rest by Cloak)
  and clear `expires_at` to NULL after grappa observed +r MODE on the
  visitor's nick. V7: NickServ-identified visitors persist forever,
  so `expires_at` is set to `nil` (not a future timestamp).

  Caller MUST pass a non-empty binary as `password`. Misuse raises
  `FunctionClauseError` — the +r MODE observation handler in
  `Grappa.Session.Server` is the documented (and only) call site, so
  let-it-crash on a bouncer-internal contract violation is the
  appropriate OTP shape.
  """
  @spec commit_password_changeset(t(), binary(), DateTime.t() | nil) :: Ecto.Changeset.t()
  def commit_password_changeset(%__MODULE__{} = visitor, password, expires_at)
      when is_binary(password) and byte_size(password) > 0 and
             (is_nil(expires_at) or is_struct(expires_at, DateTime)) do
    change(visitor, %{password_encrypted: password, expires_at: expires_at})
  end

  @doc """
  Slides `expires_at` forward on user-initiated REST/WS verbs. Caller
  enforces the ≥1h cadence (no-op if last touch <1h) — see
  `Grappa.Visitors.touch/1`.

  Time-monotonicity guard (H13, REV-D 2026-05-22): mirrors
  `Accounts.Session.touch_changeset/2` (B5.4 L-pers-3). Strictly-
  backward bumps (new < prev) are REJECTED — a system-clock skew
  (NTP step, container reboot, test fixture seeding from a fixed
  past) would otherwise silently shrink a visitor's TTL, causing
  the Reaper to delete a still-active row.

  Equal-to-prev is admitted (degenerate-but-not-skewed — a tight
  touch loop under high load can reasonably observe `now == prev`
  at usec resolution). Rows with `expires_at = nil` (V7 NickServ-
  identified visitors) are not callable here because
  `Visitors.touch/1` short-circuits the nil branch before reaching
  this changeset.

  Forced-expiry paths (`Visitors.mark_failed/2`) move the column
  backward by design and use `expire_changeset/2` instead — the
  guard would otherwise reject the legitimate "expire now" semantic.
  """
  @spec touch_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def touch_changeset(%__MODULE__{expires_at: prev} = visitor, %DateTime{} = new_expires_at) do
    cs = change(visitor, %{expires_at: new_expires_at})

    case DateTime.compare(new_expires_at, prev) do
      :lt -> add_error(cs, :expires_at, "must not move backward (system-clock skew?)")
      _ -> cs
    end
  end

  @doc """
  Forces `expires_at` to the supplied instant unconditionally — used by
  `Visitors.mark_failed/2` to expire a row immediately after upstream
  permanently rejected the visitor (k-line / terminal SASL failure).
  Distinct from `touch_changeset/2`: this changeset BYPASSES the
  monotonicity guard because the semantic is "expire NOW" (move time
  backward relative to the row's prior future-`expires_at`), which
  the guard would otherwise reject as backward-clock skew.
  """
  @spec expire_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def expire_changeset(%__MODULE__{} = visitor, %DateTime{} = at) do
    change(visitor, %{expires_at: at})
  end

  @doc """
  Rotates `:nick` after upstream confirmed the rename via NICK self-echo
  (V9, visitor-parity cluster, 2026-05-15). Validated against
  `Identifier.valid_nick?/1` so a malformed value never lands on the
  row even if the controller-boundary pre-check is bypassed in the
  future. The `(nick, network_slug)` UNIQUE constraint surfaces a
  concurrent-rename race as a changeset error, which `Visitors.update_nick/2`
  logs and propagates — DB stays consistent under racing renames.

  Schema-only changeset (mirror of `touch_changeset/2`). The IRC-side
  rotation of `state.nick` lives in `Grappa.Session.EventRouter`'s
  `:nick` handler; this changeset persists only the row mutation.
  """
  @spec nick_changeset(t(), String.t()) :: Ecto.Changeset.t()
  def nick_changeset(%__MODULE__{} = visitor, new_nick) when is_binary(new_nick) do
    visitor
    |> cast(%{nick: new_nick}, [:nick])
    |> validate_required([:nick])
    |> validate_change(:nick, &validate_nick/2)
    |> unique_constraint([:nick, :network_slug])
  end

  defp validate_nick(field, value) when is_binary(value) do
    if Identifier.valid_nick?(value),
      do: [],
      else: [{field, "must be a valid IRC nickname"}]
  end

  defp validate_network_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be a valid network slug"}]
  end

  defp validate_future_expires_at(field, %DateTime{} = value) do
    case DateTime.compare(value, DateTime.utc_now()) do
      :gt -> []
      _ -> [{field, "must be in the future"}]
    end
  end
end
