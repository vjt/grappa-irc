defmodule Grappa.Networks.Network do
  @moduledoc """
  An IRC network — a logical handle (`slug`) under which one or more
  servers (`network_servers`) are grouped and one or more users bind
  per-(user, network) credentials (`network_credentials`).

  The slug format (`^[a-z0-9_-]+$`) is intentionally narrower than IRC's
  network name conventions: it has to round-trip cleanly through URL
  paths (`/networks/:slug/...`) and PubSub topic segments
  (the `network:` segment of `grappa:user:{user}/network:{slug}/...`,
  see `Grappa.PubSub.Topic`) without escaping.

  **`slug` is immutable post-creation.** No verb mutates it; operator
  concern. The slug is baked into URL paths, PubSub topic segments,
  log keys, and the FKs every dependent row carries
  (`network_credentials.network_id`, `messages.network_id`,
  `network_servers.network_id`); a rename would orphan every one of
  those references. Operators wanting to retire a slug delete the row
  (cascading the credentials + scrollback) and recreate under the new
  slug.

  Primary key is an autoincrement INTEGER — networks are an internal
  identifier; the slug is the public handle.
  """

  # Its own boundary, last of the four Networks schemas (#1398). This is the
  # one the five `dirty_xrefs` waivers all named: a consumer that needed the
  # struct had to either waive the check or take a dep on the whole
  # `Grappa.Networks` context, and that second edge is what closed 31 cycles.
  # With the schema owning itself, the waivers become either a declared edge
  # to a leaf or nothing at all.
  #
  # `deps: [Grappa.IRC]` is the changeset's `Identifier.valid_network_slug?/1`.
  # The three `has_many` siblings are association arguments, not references
  # the checker resolves, so this leaf does not depend on them — which is why
  # four separate leaves work and no namespace move was needed.
  use Boundary, top_level?: true, deps: [Grappa.IRC]

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Networks.{Credential, FeaturedChannel, Server}

  @typedoc """
  The network's NickServ services implementation (GH #349). Determines
  which per-network REGISTER + verify command templates the cic
  registration wizard builds — `:azzurra` (bahamut + Azzurra IRC
  Services: `AUTH <code>`), `:atheme` (Libera: `VERIFY REGISTER <nick>
  <code>`), `:oftc` (oftc-ircservices), or `:unknown` (button hidden;
  nothing to register against). The enum is **server-side only** — cic
  carries intent + data, the server owns the per-network identity, so
  templates key on this operator-set flavor, NOT on the operator-arbitrary
  slug or a fragile 005 `NETWORK=` scrape. Nullable: a network the operator
  never classified reads `nil`, treated identically to `:unknown` (wizard
  button hidden).
  """
  @type services_flavor :: :azzurra | :atheme | :oftc | :unknown

  @type t :: %__MODULE__{
          id: integer() | nil,
          slug: String.t() | nil,
          services_flavor: services_flavor() | nil,
          visitor_enabled: boolean() | nil,
          visitor_autoconnect: boolean() | nil,
          max_concurrent_visitor_sessions: non_neg_integer() | nil,
          max_concurrent_user_sessions: non_neg_integer() | nil,
          max_per_ip: non_neg_integer() | nil,
          servers: [Server.t()] | Ecto.Association.NotLoaded.t(),
          credentials: [Credential.t()] | Ecto.Association.NotLoaded.t(),
          featured_channels: [FeaturedChannel.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "networks" do
    field :slug, :string
    # GH #349 — the network's NickServ services implementation, set by
    # the operator (bind-time or admin PATCH). Drives the cic
    # registration wizard's per-network REGISTER/verify templates.
    # Nullable (`nil` == "unclassified", wizard hidden); Ecto.Enum
    # rejects any value outside the closed set at the changeset boundary.
    field :services_flavor, Ecto.Enum, values: [:azzurra, :atheme, :oftc, :unknown]
    # #211 phase 1 — runtime per-network visitor allowlist flag.
    # Replaces the compile-time `:visitor_network` pin: an admin can
    # toggle which networks accept visitor attachment without a restart.
    # The login/attach READ of this column is phase 3; phase 1 only lands
    # the column + field + default. Default `false` — visitors disabled
    # per-network unless an admin opts a network in ("play safe", vjt
    # 2026-07-11). Schema default mirrors the DB column default so
    # `Repo.insert/2` returns a struct matching the persisted row.
    field :visitor_enabled, :boolean, default: false
    # #211 phase 6 — the SUBSET of `visitor_enabled` a visitor
    # auto-connects at login (ruling C: "NO picker, NO extra login
    # step"). `visitor_enabled` = "visitors ALLOWED" (the AVAILABLE tier,
    # shown on home for on-demand one-tap connect); `visitor_autoconnect`
    # = the subset auto-dialed at login (multi-network, zero friction).
    # A strict subset at the admin-intent level (login + home readers AND
    # it with `visitor_enabled`); the columns are independent booleans
    # (no DB CHECK — a network toggled `visitor_enabled=false` while
    # still `visitor_autoconnect=true` is a benign no-op filtered at read
    # time). Default `false`; the continuity seed
    # (`20260712120100`) flips it true for networks that today
    # auto-connect visitors, preserving pre-phase-6 single-network
    # behavior.
    field :visitor_autoconnect, :boolean, default: false
    # U-1 split: visitor + user caps independently. Visitor cap inherits
    # the historic `max_concurrent_sessions` value via migration rename;
    # user cap defaults to 3 at both the DB level (column DEFAULT 3) and
    # the schema level (so `Repo.insert/2` returns a struct matching the
    # DB row, not a nil-divergence). NULL on either column means
    # "unlimited" — three-valued contract unchanged from the pre-U-1
    # single column.
    field :max_concurrent_visitor_sessions, :integer
    field :max_concurrent_user_sessions, :integer, default: 3
    # #171: per-(source-IP, network) clone cap. Renamed from
    # `max_per_client` when the per-(client, network) dimension was
    # dropped — visitors have no stable client identity, so the source IP
    # is the only durable per-actor handle; authed users are capped
    # per-IP too. nil = unlimited, 0 = lock-down, N>0 = the cap.
    field :max_per_ip, :integer

    has_many :servers, Server
    has_many :credentials, Credential
    has_many :featured_channels, FeaturedChannel

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a create-or-update changeset. `slug` is required and must
  match the URL/topic-safe format; uniqueness is enforced both at the
  changeset and DB layers (`networks_slug_index`).

  Slug syntax + length is the same `Identifier.valid_network_slug?/1`
  rule applied everywhere else the slug appears (URL paths, PubSub
  topics, log keys). A18 unified the rule: the previous local
  `@slug_format` regex + `validate_length(min: 1, max: 64)` pair
  drifted from Identifier (cap 32) — picking 32 here closes the gap
  per DESIGN_NOTES 2026-04-26.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(network, attrs) do
    network
    |> cast(attrs, [
      :slug,
      :services_flavor,
      :visitor_enabled,
      :visitor_autoconnect,
      :max_concurrent_visitor_sessions,
      :max_concurrent_user_sessions,
      :max_per_ip
    ])
    |> validate_required([:slug])
    |> validate_change(:slug, &validate_slug/2)
    |> validate_change(:max_concurrent_visitor_sessions, &validate_non_negative_or_nil/2)
    |> validate_change(:max_concurrent_user_sessions, &validate_non_negative_or_nil/2)
    |> validate_change(:max_per_ip, &validate_non_negative_or_nil/2)
    |> unique_constraint(:slug)
  end

  defp validate_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be lowercase alphanumeric with _ or -, 1-32 chars"}]
  end

  # Caps follow a three-valued contract: nil = unlimited (operator clears
  # the cap), 0 = degenerate lock-down (allow none — explicit operator
  # intent), N>0 = the actual cap. Negative integers and non-integer
  # values are invalid. validate_change/3 only fires when the field is
  # present in the changeset's :changes — unsupplied keys keep their
  # current value (per the "supply only what you want to change" verb
  # contract on Networks.update_network_settings/2).
  defp validate_non_negative_or_nil(_, nil), do: []
  defp validate_non_negative_or_nil(_, n) when is_integer(n) and n >= 0, do: []
  defp validate_non_negative_or_nil(field, _), do: [{field, "must be non-negative integer or nil"}]
end
