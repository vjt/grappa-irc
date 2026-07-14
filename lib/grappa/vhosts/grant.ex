defmodule Grappa.Vhosts.Grant do
  @moduledoc """
  Schema for `vhost_grants` — a per-subject grant of a `vhosts` row (#228).

  Subject XOR FK (`user_id` XOR `visitor_id`), the SAME shape as
  `read_cursors` / `user_settings` / `network_credentials`. A grant means
  "`subject` may select this vhost even if it isn't `generally_available`."

    * `pinned = false` — a curated availability grant: the subject may
      self-select this vhost (union with the generally-available set).
    * `pinned = true` — an admin-forced fixed bind: the subject's
      effective source is this vhost, not self-changeable (an oper O:line
      host). Context enforces at most one pin per subject.

  Visitor grants CASCADE on visitor reap (#211 reaper interaction) — a
  reaped visitor releases its grants automatically, no leak.

  Public API on `Grappa.Vhosts`; callers receive `%Grant{}` structs by
  type and reference the schema only via the parent context.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Vhosts.Vhost
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          vhost_id: integer() | nil,
          vhost: Vhost.t() | Ecto.Association.NotLoaded.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          pinned: boolean() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "vhost_grants" do
    belongs_to :vhost, Vhost
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id

    field :pinned, :boolean, default: false

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an insert/update changeset. `vhost_id` + subject XOR required;
  `assoc_constraint/2` converts a missing parent FK into a changeset
  error (mirror of `ReadCursor.Cursor.changeset/2`).
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(grant, attrs) do
    grant
    |> cast(attrs, [:vhost_id, :user_id, :visitor_id, :pinned])
    |> validate_required([:vhost_id])
    |> validate_subject_xor()
    |> assoc_constraint(:vhost)
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint(:vhost_id, name: :vhost_grants_vhost_id_user_id_index)
    |> unique_constraint(:vhost_id, name: :vhost_grants_vhost_id_visitor_id_index)
    |> check_constraint(:subject,
      name: :vhost_grants_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # Mirror of ReadCursor.Cursor.validate_subject_xor/1.
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end
end
