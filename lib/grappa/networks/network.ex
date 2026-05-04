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

  Primary key is an autoincrement INTEGER — networks are an internal
  identifier; the slug is the public handle.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Networks.{Credential, Server}

  @type t :: %__MODULE__{
          id: integer() | nil,
          slug: String.t() | nil,
          max_concurrent_sessions: non_neg_integer() | nil,
          max_per_client: non_neg_integer() | nil,
          servers: [Server.t()] | Ecto.Association.NotLoaded.t(),
          credentials: [Credential.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "networks" do
    field :slug, :string
    field :max_concurrent_sessions, :integer
    field :max_per_client, :integer

    has_many :servers, Server
    has_many :credentials, Credential

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
    |> cast(attrs, [:slug, :max_concurrent_sessions, :max_per_client])
    |> validate_required([:slug])
    |> validate_change(:slug, &validate_slug/2)
    |> validate_change(:max_concurrent_sessions, &validate_non_negative_or_nil/2)
    |> validate_change(:max_per_client, &validate_non_negative_or_nil/2)
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
  # contract on Networks.update_network_caps/2).
  defp validate_non_negative_or_nil(_, nil), do: []
  defp validate_non_negative_or_nil(_, n) when is_integer(n) and n >= 0, do: []
  defp validate_non_negative_or_nil(field, _), do: [{field, "must be non-negative integer or nil"}]
end
