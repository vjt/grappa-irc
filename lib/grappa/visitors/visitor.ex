defmodule Grappa.Visitors.Visitor do
  @moduledoc """
  Self-service visitor IDENTITY row — a pure identity/TTL row.

  ## #211 phase 7 — the contract

  A visitor is MULTI-network. All per-network identity
  (nick/ident/realname/password/auth_method) lives on the
  `network_credentials` rows (one per attached network, XOR-keyed on
  `visitor_id`). The visitor row itself carries ONLY the identity-wide
  lifecycle fields: the surrogate `id` (the stable identity key every
  `visitor_id` FK points at), the `expires_at` TTL, the audit `ip`, and
  timestamps. The `nick`/`network_slug`/`ident`/`realname`/
  `password_encrypted`/`last_joined_channels` scalars were dropped in the
  phase-7 native `ALTER TABLE ... DROP COLUMN` migration (NOT a
  table-recreate — `visitors` is a parent table with seven inbound FKs; a
  rename-aside would dangle them, see the migration moduledoc).

  ## Lifecycle

  - Created on first `POST /auth/login` with a non-`@` identifier —
    `Grappa.Visitors.find_or_provision_anon/3` inserts this bare row PLUS
    an anon `(visitor_id, network)` credential atomically.
  - `expires_at` is the anon sliding-TTL clock: it slides forward on
    user-initiated REST/WS verbs (≥1h cadence) up to the 48h TTL. #211
    phase 7 — `commit_password/3` NO LONGER clears it; registration is
    DERIVED from the credentials (`Credentials.visitor_registered?/1` =
    holds ≥1 credential with a committed NickServ secret on ANY network),
    NOT a stored `expires_at`-nil flag. A registered visitor therefore
    still carries an anon-shaped `expires_at` value; the derived predicate
    (not the nil check) is what overrides expiry wherever "permanent"
    matters (`list_active/0`, `list_expired/0`, `count_active_for_ip/1`,
    `touch/1`), and the `registered` boolean on the wire comes from that
    same derivation. Unbinding the last registered credential makes the
    identity anon again, automatically — no flag to drift.
  - Legacy pre-phase-7 permanent rows carry `expires_at == nil` AND ≥1
    NickServ credential; both the nil-guard and the derived check keep them
    alive.
  - Reaped by `Grappa.Visitors.Reaper` when
    `expires_at IS NOT NULL AND expires_at <= now() AND NOT registered`.
    CASCADE wipes related rows in `network_credentials`, `messages`,
    `accounts_sessions`, and the visitor's PRIVATE `themes`. A reaped
    visitor's PUBLISHED themes are the one exception: they re-home to the
    system user (`Grappa.Themes.rehome_visitor_published_to_system/1`, run
    inside `Grappa.Visitors.delete/1`'s txn BEFORE the delete) so gallery
    contributions survive — #299.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          expires_at: DateTime.t() | nil,
          ip: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitors" do
    field :expires_at, :utc_datetime_usec
    field :ip, :string

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an anon-visitor create changeset for the pure identity/TTL row.
  Required field: `:expires_at` (`:ip` optional). #211 phase 7 — nick +
  network + identity now live on the anon credential the caller
  (`Grappa.Visitors.find_or_provision_anon/3`) inserts alongside this row
  in the same transaction, so they are NOT cast here.

  `:expires_at` must be strictly in the future (B5.4 M-pers-3): a row born
  already-expired would be reaped on the next `Reaper` sweep. The
  `validate_change` only fires when `:expires_at` is present
  (`validate_required` runs first), so a missing field surfaces a single
  "can't be blank" error rather than an additional confusing "must be in
  the future" against `nil`.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:expires_at, :ip])
    |> validate_required([:expires_at])
    |> validate_change(:expires_at, &validate_future_expires_at/2)
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
  at usec resolution). Rows with `expires_at = nil` (legacy pre-phase-7
  permanent visitors) are not callable here because `Visitors.touch/1`
  short-circuits the nil branch before reaching this changeset.
  Post-phase-7 registered visitors carry an anon-shaped non-nil
  `expires_at` and DO reach this changeset, but `touch/1`'s derived
  registered-check no-ops them before the bump.

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
  Refreshes `:ip` to the current client address observed at login.
  Schema-only changeset.

  For a long-lived registered visitor (a legacy pre-phase-7 permanent row
  with `expires_at: nil`, or a post-phase-7 identity registered via a
  credential), the audit value would otherwise freeze at the row's birth IP
  regardless of how many times the holder logged in from a different
  network. Cic's admin Visitors tab consequently showed stale (often
  nginx-bridge) addresses indefinitely.

  Wire-validated as `String.t() | nil`: callers (the controller boundary
  that already saw `conn.remote_ip` post-`RemoteIpFromProxy`) pass either
  the formatted client IP or `nil`. No format validation here — the wire
  shape is whatever `GrappaWeb.RemoteIP.format/1` produces.
  """
  @spec ip_changeset(t(), String.t() | nil) :: Ecto.Changeset.t()
  def ip_changeset(%__MODULE__{} = visitor, new_ip)
      when is_binary(new_ip) or is_nil(new_ip) do
    change(visitor, %{ip: new_ip})
  end

  defp validate_future_expires_at(field, %DateTime{} = value) do
    case DateTime.compare(value, DateTime.utc_now()) do
      :gt -> []
      _ -> [{field, "must be in the future"}]
    end
  end
end
