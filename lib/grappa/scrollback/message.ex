defmodule Grappa.Scrollback.Message do
  @moduledoc """
  One row of IRC scrollback.

  `kind` is a closed-set atom backed by `Ecto.Enum` (stored as a string
  in sqlite — sqlite has no native enum type). Cast-time validation
  rejects unknown values; raw SQL inserts that bypass Ecto are forbidden
  by CLAUDE.md ("Never apply DDL manually via raw SQL"). See CLAUDE.md
  "Atoms or `@type t :: literal | literal` — never untyped strings for
  closed sets."

  `server_time` is epoch milliseconds. IRC's `server-time` IRCv3 tag
  is RFC3339; the conversion happens at the parser/inserter boundary.
  Integer storage is sortable lexically and avoids TZ ambiguity in
  sqlite. The `(network_id, channel, server_time)` index makes
  per-channel paginated DESC scans cheap — Phase 6's IRCv3
  `CHATHISTORY` listener relies on this exact shape.

  `body` is canonical UTF-8 (the IRC parser converts incoming bytes
  at the boundary; CTCP `\\x01` framing is preserved verbatim per
  CLAUDE.md "wire-format rule").
  """
  use Ecto.Schema
  import Ecto.Changeset

  @kinds [:privmsg, :notice, :action]

  @type kind :: :privmsg | :notice | :action

  @type t :: %__MODULE__{
          id: integer() | nil,
          network_id: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t(),
          inserted_at: DateTime.t() | nil
        }

  schema "messages" do
    field :network_id, :string
    field :channel, :string
    field :server_time, :integer
    field :kind, Ecto.Enum, values: @kinds
    field :sender, :string
    field :body, :string

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc """
  Builds an insert changeset. All fields required; `:kind` is validated
  against the `Ecto.Enum` value set at cast time.
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(message, attrs) do
    message
    |> cast(attrs, [:network_id, :channel, :server_time, :kind, :sender, :body])
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender, :body])
  end
end
