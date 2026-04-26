defmodule Grappa.Networks.Server do
  @moduledoc """
  An IRC server endpoint attached to a `Grappa.Networks.Network`.

  Tuple of `(host, port, tls)` is what `Grappa.IRC.Client` consumes at
  connect time. `priority` (asc) is the ordering hint for fail-over —
  the lowest-numbered enabled server is tried first; Phase 5 deferred
  fail-over policy will iterate the list. `enabled: false` lets an
  operator park a server without removing the row (audit + history).

  `(network_id, host, port)` is unique — re-adding the same triple
  surfaces `{:error, :already_exists}` from the context, not a raw
  Ecto changeset error.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Networks.Network

  @type t :: %__MODULE__{
          id: integer() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          host: String.t() | nil,
          port: :inet.port_number() | nil,
          tls: boolean() | nil,
          priority: integer() | nil,
          enabled: boolean() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "network_servers" do
    belongs_to :network, Network

    field :host, :string
    field :port, :integer
    field :tls, :boolean, default: true
    field :priority, :integer, default: 0
    field :enabled, :boolean, default: true

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a create/update changeset. Required fields: `:network_id`,
  `:host`, `:port`. The `(network_id, host, port)` unique constraint
  is mapped to `:already_exists` by `Grappa.Networks.add_server/2`;
  callers of this changeset directly will see a normal Ecto.Changeset
  error instead.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(server, attrs) do
    server
    |> cast(attrs, [:network_id, :host, :port, :tls, :priority, :enabled])
    |> validate_required([:network_id, :host, :port])
    |> validate_length(:host, min: 1, max: 255)
    |> validate_number(:port, greater_than: 0, less_than_or_equal_to: 65_535)
    |> unique_constraint([:network_id, :host, :port],
      name: :network_servers_network_id_host_port_index
    )
  end
end
