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

  alias Grappa.Networks.{Credential, Server}

  @type t :: %__MODULE__{
          id: integer() | nil,
          slug: String.t() | nil,
          servers: [Server.t()] | Ecto.Association.NotLoaded.t(),
          credentials: [Credential.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "networks" do
    field :slug, :string

    has_many :servers, Server
    has_many :credentials, Credential

    timestamps(type: :utc_datetime_usec)
  end

  @slug_format ~r/^[a-z0-9_\-]+$/

  @doc """
  Builds a create-or-update changeset. `slug` is required and must
  match the URL/topic-safe format; uniqueness is enforced both at the
  changeset and DB layers (`networks_slug_index`).
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(network, attrs) do
    network
    |> cast(attrs, [:slug])
    |> validate_required([:slug])
    |> validate_length(:slug, min: 1, max: 64)
    |> validate_format(:slug, @slug_format, message: "must be lowercase alphanumeric with _ or -")
    |> unique_constraint(:slug)
  end
end
