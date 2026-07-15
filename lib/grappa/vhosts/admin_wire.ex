defmodule Grappa.Vhosts.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shapes for the #228 vhost admin surface
  (`/admin/vhosts` + grants). Sibling to `Grappa.Networks.AdminWire`;
  explicit per-field projection (no wildcard `Map.take/2`) so a future
  schema field is a deliberate edit here (CLAUDE.md "no leaky
  abstractions").
  """
  alias Grappa.Vhosts.{Grant, Vhost}

  @type vhost_json :: %{
          id: integer(),
          address: String.t(),
          in_pool: boolean(),
          generally_available: boolean(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @type grant_json :: %{
          id: integer(),
          vhost_id: integer(),
          subject_type: String.t(),
          subject_id: String.t()
        }

  @doc "Renders a vhost row to the admin JSON shape."
  @spec vhost_to_admin_json(Vhost.t()) :: vhost_json()
  def vhost_to_admin_json(%Vhost{} = v) do
    %{
      id: v.id,
      address: v.address,
      in_pool: v.in_pool,
      generally_available: v.generally_available,
      inserted_at: v.inserted_at,
      updated_at: v.updated_at
    }
  end

  @doc """
  Renders a grant row to the admin JSON shape. The subject is projected
  as a `(subject_type, subject_id)` pair (the XOR FK, never both) so the
  wire is subject-polymorphic without leaking which column is NULL.
  """
  @spec grant_to_admin_json(Grant.t()) :: grant_json()
  def grant_to_admin_json(%Grant{user_id: uid} = g) when is_binary(uid) do
    base_grant_json(g, "user", uid)
  end

  def grant_to_admin_json(%Grant{visitor_id: vid} = g) when is_binary(vid) do
    base_grant_json(g, "visitor", vid)
  end

  defp base_grant_json(%Grant{} = g, subject_type, subject_id) do
    %{
      id: g.id,
      vhost_id: g.vhost_id,
      subject_type: subject_type,
      subject_id: subject_id
    }
  end
end
