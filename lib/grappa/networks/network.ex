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
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Networks.{Credential, FeaturedChannel, Server}

  @type t :: %__MODULE__{
          id: integer() | nil,
          slug: String.t() | nil,
          visitor_enabled: boolean() | nil,
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
    # #211 phase 1 — runtime per-network visitor allowlist flag.
    # Replaces the compile-time `:visitor_network` pin: an admin can
    # toggle which networks accept visitor attachment without a restart.
    # The login/attach READ of this column is phase 3; phase 1 only lands
    # the column + field + default. Default `false` — visitors disabled
    # per-network unless an admin opts a network in ("play safe", vjt
    # 2026-07-11). Schema default mirrors the DB column default so
    # `Repo.insert/2` returns a struct matching the persisted row.
    field :visitor_enabled, :boolean, default: false
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
      :visitor_enabled,
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
