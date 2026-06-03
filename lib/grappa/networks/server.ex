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
          source_address: String.t() | nil,
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
    field :source_address, :string

    timestamps(type: :utc_datetime_usec)
  end

  @ip_literal_error "must be a literal IPv4 or IPv6 address (no hostname, CIDR, or port)"

  @doc """
  Builds a create/update changeset. Required fields: `:network_id`,
  `:host`, `:port`. The `(network_id, host, port)` unique constraint
  is mapped to `:already_exists` by `Grappa.Networks.Servers.add_server/2`;
  callers of this changeset directly will see a normal Ecto.Changeset
  error instead.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(server, attrs) do
    server
    |> cast(attrs, [:network_id, :host, :port, :tls, :priority, :enabled, :source_address])
    # Re-cast source_address with empty_values: [] so an explicit "" is
    # kept as a change (Ecto's default empty_values: [""] would silently
    # coerce it to nil and bypass the strict-literal check below). Scoped
    # to this one field so the other casts keep their default
    # blank-is-nil semantics.
    |> cast(attrs, [:source_address], empty_values: [])
    |> validate_required([:network_id, :host, :port])
    |> validate_length(:host, min: 1, max: 255)
    |> validate_number(:port, greater_than: 0, less_than_or_equal_to: 65_535)
    |> validate_source_address()
    |> unique_constraint([:network_id, :host, :port],
      name: :network_servers_network_id_host_port_index
    )
  end

  # `source_address`, when set, MUST be a strict literal IPv4 or IPv6
  # address — no hostname (the operator resolves m42.openssl.it
  # themselves), no CIDR, no empty string. A strict parse makes the
  # bind family unambiguous and the pool subtraction a static set
  # difference (spec §1, decision 2). On success the value is rewritten
  # to its canonical form (`:inet.ntoa/1`) so the stored string is
  # stable regardless of how the operator typed it. The empty string is
  # preserved as a change by the scoped empty_values: [] cast above and
  # falls through to the strict-parse rejection here.
  @spec validate_source_address(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_source_address(changeset) do
    case fetch_change(changeset, :source_address) do
      :error -> changeset
      {:ok, nil} -> changeset
      {:ok, value} -> validate_ip_literal(changeset, value)
    end
  end

  defp validate_ip_literal(changeset, value) do
    charlist = String.to_charlist(value)

    case {:inet.parse_ipv4strict_address(charlist), :inet.parse_ipv6strict_address(charlist)} do
      {{:ok, tuple}, _} -> put_canonical(changeset, tuple)
      {_, {:ok, tuple}} -> put_canonical(changeset, tuple)
      _ -> add_error(changeset, :source_address, @ip_literal_error)
    end
  end

  defp put_canonical(changeset, tuple),
    do: put_change(changeset, :source_address, to_string(:inet.ntoa(tuple)))
end
