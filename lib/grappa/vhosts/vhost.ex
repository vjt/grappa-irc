defmodule Grappa.Vhosts.Vhost do
  @moduledoc """
  Schema for `vhosts` — one curated source-bind address (#228).

  The candidate universe is the host's bound addresses
  (`Grappa.Net.HostAddresses.list/0`); a `vhosts` row is one the operator
  curated in. `address` is a strict IP literal, canonicalized through the
  shared `Grappa.Net.IpLiteral` helper (SAME rule as
  `Grappa.Networks.Server.source_address`).

    * `in_pool` — member of the auto-rotation pool (replaces the
      `GRAPPA_OUTBOUND_V6_POOL` env var; `Grappa.OutboundV6Pool` draws
      its rotation set from `in_pool = true` rows).
    * `generally_available` — any subject may self-select this vhost
      (vs. an admin grant to specific subjects via `vhost_grants`).

  Public API on `Grappa.Vhosts`; callers receive `%Vhost{}` structs by
  type and reference the schema only via the parent context.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Net.IpLiteral

  @type t :: %__MODULE__{
          id: integer() | nil,
          address: String.t() | nil,
          in_pool: boolean() | nil,
          generally_available: boolean() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "vhosts" do
    field :address, :string
    field :in_pool, :boolean, default: false
    field :generally_available, :boolean, default: false

    timestamps(type: :utc_datetime_usec)
  end

  @address_error "must be a literal IPv4 or IPv6 address (no hostname, CIDR, or port)"

  @doc """
  Builds a create/update changeset. `address` required + strict-literal
  validated + canonicalized (via `Grappa.Net.IpLiteral`); the two
  availability flags cast straight through (default false at the schema).
  The `(address)` unique constraint is mapped to `:already_exists` by
  `Grappa.Vhosts.create_vhost/1`.
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(vhost, attrs) do
    vhost
    |> cast(attrs, [:address, :in_pool, :generally_available])
    # Re-cast address with empty_values: [] so an explicit "" is kept as
    # a change and hits the strict-literal rejection (mirror of
    # Server.changeset/2's scoped empty_values cast).
    |> cast(attrs, [:address], empty_values: [])
    |> validate_required([:address])
    |> validate_address()
    |> unique_constraint(:address, name: :vhosts_address_index)
  end

  @spec validate_address(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_address(changeset) do
    case fetch_change(changeset, :address) do
      :error ->
        changeset

      {:ok, value} ->
        case IpLiteral.canonicalize(value) do
          {:ok, canonical} -> put_change(changeset, :address, canonical)
          :error -> add_error(changeset, :address, @address_error)
        end
    end
  end
end
