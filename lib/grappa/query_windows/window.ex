defmodule Grappa.QueryWindows.Window do
  @moduledoc """
  Schema for `query_windows` — one row per (user, network, target_nick)
  open DM window.

  Public API lives in `Grappa.QueryWindows`; callers receive `%Window{}`
  structs by type and reference the schema only via the parent context.
  The Boundary annotation on `Grappa.QueryWindows` exports this module
  so the `t()` cross-module reference resolves cleanly in published
  docs.

  See `Grappa.QueryWindows` for the upsert / delete / list semantics.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Networks.Network

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          target_nick: String.t() | nil,
          opened_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "query_windows" do
    belongs_to :user, User, type: :binary_id
    belongs_to :network, Network

    field :target_nick, :string
    field :opened_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert changeset. All fields are required; no optional
  defaults. The `opened_at` is supplied by the caller (context sets it
  to `DateTime.utc_now()` at insert time) so the changeset stays pure.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(window, attrs) do
    window
    |> cast(attrs, [:user_id, :network_id, :target_nick, :opened_at])
    |> validate_required([:user_id, :network_id, :target_nick, :opened_at])
    |> validate_length(:target_nick, min: 1)
  end
end
