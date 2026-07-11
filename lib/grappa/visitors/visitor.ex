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
    related rows in `messages`, `accounts_sessions`.

  ## Per-row network pinning
  `network_slug` is fixed at row creation. A config rotation
  (`GRAPPA_VISITOR_NETWORK` change) renders existing rows orphans —
  `Grappa.Bootstrap` hard-errors with operator instructions to run
  `mix grappa.reap_visitors --network=<old_slug>`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.EncryptedBinary
  alias Grappa.IRC.{Identifier, Identity}

  # Hard ceiling on the per-visitor `last_joined_channels` snapshot.
  # Mirror of `Grappa.Networks.Credential.@last_joined_channels_max`.
  # Bounds the JSON column write + boot-time merge cost so a
  # pathological session can't grow the snapshot without limit.
  @last_joined_channels_max 200

  @doc """
  Returns the schema-level cap on `last_joined_channels` length. Public
  so the context helper (`Visitors.update_last_joined_channels/2`) can
  pre-truncate the input list using the same constant the changeset
  validator enforces.
  """
  @spec last_joined_channels_max() :: unquote(@last_joined_channels_max)
  def last_joined_channels_max, do: @last_joined_channels_max

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          nick: String.t() | nil,
          ident: String.t() | nil,
          realname: String.t() | nil,
          network_slug: String.t() | nil,
          password_encrypted: binary() | nil,
          expires_at: DateTime.t() | nil,
          ip: String.t() | nil,
          last_joined_channels: [String.t()],
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitors" do
    field :nick, :string
    # GH #152 — user-settable IRC ident + realname, decoupled from nick.
    # Both nullable free-form attrs (non-unique). `ident` falls back to
    # nick when unset (`Grappa.Visitors.SessionPlan`); `realname` falls
    # back to the `"Grappa Visitor"` anon-branding default (vjt ruling E).
    field :ident, :string
    field :realname, :string
    field :network_slug, :string
    field :password_encrypted, EncryptedBinary, redact: true
    field :expires_at, :utc_datetime_usec
    field :ip, :string
    field :last_joined_channels, {:array, :string}, default: []

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an anon-visitor create changeset. Required fields: `:nick`,
  `:network_slug`, `:expires_at`. `:ip` is optional. Validates `:nick`
  against `Identifier.valid_nick?/1` and `:network_slug` against
  `Identifier.valid_network_slug?/1` — both are wire-bound (PubSub
  topics + IRC handshake), so syntactic hygiene is enforced at the
  boundary. Uniqueness on `(rfc1459-fold(nick), network_slug)` per W2 +
  GH #121 — the unique index is on the rfc1459-folded nick expression
  (display case preserved on `:nick`), so `Mezmerize` and `mezmerize`
  are one identity. `unique_constraint/3` is pinned to the named
  expression index `:visitors_nick_folded_network_slug_index`.

  `:expires_at` must be strictly in the future (B5.4 M-pers-3): a row
  born already-expired would be reaped on the next `Reaper` sweep but
  in the meantime would consume `(folded-nick, network_slug)` uniqueness
  and shadow a legitimate concurrent registration. The `validate_change`
  only fires when `:expires_at` is present (`validate_required` runs
  first), so a missing field surfaces a single "can't be blank" error
  rather than an additional confusing "must be in the future" against
  `nil`.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:nick, :ident, :realname, :network_slug, :expires_at, :ip])
    |> Identity.sanitize_ident()
    |> validate_required([:nick, :network_slug, :expires_at])
    |> validate_change(:nick, &Identity.validate_nick/2)
    |> validate_change(:ident, &Identity.validate_ident/2)
    |> validate_change(:realname, &Identity.safe_line_token/2)
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> validate_change(:expires_at, &validate_future_expires_at/2)
    |> unique_constraint(:nick, name: :visitors_nick_folded_network_slug_index)
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
  GH #152 — live-apply changeset for a visitor's user-settable IRC
  identity (`ident` + `realname`). Schema-only mutation (mirror of
  `nick_changeset/2`); the reconnect that re-registers the upstream with
  the new values is driven by `Grappa.Visitors.update_identity/2`.

  `ident` is sanitized (leading-`~` strip, anti-spoof — grappa runs no
  identd) then shape-validated (`Identifier.valid_ident?/1`, cap 10).
  `realname` is free-form trailing text — only the CR/LF/NUL wire-hygiene
  guard applies (no anti-spoof; realname isn't an identd surface). Both
  optional: an empty attrs map is a valid no-op (the controller may PATCH
  just one field).
  """
  @spec identity_changeset(t(), map()) :: Ecto.Changeset.t()
  def identity_changeset(%__MODULE__{} = visitor, attrs) when is_map(attrs) do
    visitor
    |> cast(attrs, [:ident, :realname])
    |> Identity.sanitize_ident()
    |> validate_change(:ident, &Identity.validate_ident/2)
    |> validate_change(:realname, &Identity.safe_line_token/2)
  end

  @doc """
  Rotates `:nick` after upstream confirmed the rename via NICK self-echo
  (V9, visitor-parity cluster, 2026-05-15). Validated against
  `Identifier.valid_nick?/1` so a malformed value never lands on the
  row even if the controller-boundary pre-check is bypassed in the
  future. The `(rfc1459-fold(nick), network_slug)` UNIQUE expression
  index (GH #121) surfaces a concurrent-rename race as a changeset
  error, which `Visitors.update_nick/2` logs and propagates — DB stays
  consistent under racing renames.

  Schema-only changeset (mirror of `touch_changeset/2`). The IRC-side
  rotation of `state.nick` lives in `Grappa.Session.EventRouter`'s
  `:nick` handler; this changeset persists only the row mutation.
  """
  @spec nick_changeset(t(), String.t()) :: Ecto.Changeset.t()
  def nick_changeset(%__MODULE__{} = visitor, new_nick) when is_binary(new_nick) do
    visitor
    |> cast(%{nick: new_nick}, [:nick])
    |> validate_required([:nick])
    |> validate_change(:nick, &Identity.validate_nick/2)
    |> unique_constraint(:nick, name: :visitors_nick_folded_network_slug_index)
  end

  @doc """
  Refreshes `:ip` to the current client address observed at login.
  Schema-only changeset (mirror of `nick_changeset/2`).

  Pre-fix the `:ip` column was set ONLY at row creation
  (`create_changeset/1` via `find_or_provision_anon/3`). For a
  long-lived NickServ-identified visitor (V7 — `expires_at: nil`),
  the audit value froze at the row's birth IP regardless of how
  many times the holder logged in from a different network. Cic's
  admin Visitors tab consequently showed stale (often nginx-bridge)
  addresses indefinitely.

  Wire-validated as `String.t() | nil`: callers (the controller
  boundary that already saw `conn.remote_ip` post-`RemoteIpFromProxy`)
  pass either the formatted client IP or `nil` (logged-in via a path
  with no remote_ip). No format validation here — the wire shape is
  whatever `GrappaWeb.RemoteIP.format/1` produces.
  """
  @spec ip_changeset(t(), String.t() | nil) :: Ecto.Changeset.t()
  def ip_changeset(%__MODULE__{} = visitor, new_ip)
      when is_binary(new_ip) or is_nil(new_ip) do
    change(visitor, %{ip: new_ip})
  end

  @doc """
  Overwrites the `last_joined_channels` snapshot. Mirror of the
  user-side `Grappa.Networks.Credential.changeset/2` path for the
  same field — `Session.Server` writes via this changeset on every
  self-JOIN / self-PART / self-KICK so a graceful or crash restart
  can rehydrate the channel list at boot.

  Canonicalises each entry (`Identifier.canonical_channel/1`) so the
  on-disk shape matches what `Session.Server.init/1` re-canonicalises
  at the autojoin entry-point. Caps to `last_joined_channels_max/0`
  entries at the changeset boundary so any bypass of the context
  helper (`Visitors.update_last_joined_channels/2`) still observes
  the ceiling.
  """
  @spec last_joined_channels_changeset(t(), [String.t()]) :: Ecto.Changeset.t()
  def last_joined_channels_changeset(%__MODULE__{} = visitor, channels)
      when is_list(channels) do
    canonical = Enum.map(channels, &canonicalize_entry/1)

    visitor
    |> cast(%{last_joined_channels: canonical}, [:last_joined_channels])
    |> validate_change(:last_joined_channels, &validate_channel_list/2)
    |> validate_length(:last_joined_channels, max: @last_joined_channels_max)
  end

  defp canonicalize_entry(name) when is_binary(name), do: Identifier.canonical_channel(name)
  defp canonicalize_entry(other), do: other

  defp validate_channel_list(field, list) when is_list(list) do
    Enum.flat_map(list, fn name ->
      cond do
        not is_binary(name) -> [{field, "must contain only strings"}]
        not Identifier.valid_channel?(name) -> [{field, "invalid channel name: #{inspect(name)}"}]
        true -> []
      end
    end)
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
