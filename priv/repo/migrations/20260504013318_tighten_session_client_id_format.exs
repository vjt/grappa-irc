defmodule Grappa.Repo.Migrations.TightenSessionClientIdFormat do
  @moduledoc """
  Schema-version inflection point for decision E (cluster/t31-cleanup):
  the `client_id` column is now typed as `Grappa.ClientId` (UUID v4
  canonical form) at the schema layer.

  No DDL: the column type itself stays `:string` (sqlite TEXT). The
  format invariant is enforced in Elixir at:

    * `cast/1` — `Grappa.ClientId.cast/1` rejects non-UUID-v4 input
      from `Session.changeset/2` (and from any future changeset that
      casts the field).
    * `load/1` — re-validated on schema load, so any direct-SQL write
      that bypasses the changeset surfaces as a load error rather than
      silently flowing through the application as a malformed string.

  This migration exists to mark the inflection in `schema_migrations`
  so an operator running `mix ecto.migrations` after pulling B5.1 sees
  the tightening applied. There is intentionally nothing to do or undo
  at the DDL layer — `def change, do: :ok` is correct (NOT `nil`,
  which would raise on rollback).
  """

  use Ecto.Migration

  def change, do: :ok
end
