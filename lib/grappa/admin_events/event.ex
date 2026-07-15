defmodule Grappa.AdminEvents.Event do
  @moduledoc """
  Ecto schema for one persisted `admin_events` row (#215 Option B) — the
  disk mirror of the `Grappa.AdminEvents` in-memory ring.

  `payload` holds the full `Grappa.AdminEvents.Wire` event map as JSON;
  `kind` is broken out (string projection of the event's `:kind` atom) for
  operator filtering. Round-tripping JSON yields a string-keyed map — which
  is byte-identical over the wire to a fresh atom-keyed event, and is never
  atom-matched server-side (the ring is opaque, serialized straight to cic).

  Public API on `Grappa.AdminEvents`; the schema is internal storage.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: integer() | nil,
          kind: String.t() | nil,
          payload: map() | nil
        }

  schema "admin_events" do
    field :kind, :string
    field :payload, :map
  end

  @doc """
  Builds an insert changeset from a `Grappa.AdminEvents.Wire` event map.
  `kind` is derived by the caller (the atom projected to a string).
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(event, attrs) do
    event
    |> cast(attrs, [:kind, :payload])
    |> validate_required([:kind, :payload])
  end
end
