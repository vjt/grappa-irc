defmodule Grappa.SessionLog.Event do
  @moduledoc """
  Ecto schema for one persisted `session_log_events` row (#215).

  A uniform shape across all lifecycle events (`event` is the closed-set
  discriminator); event-specific extras are nullable columns
  (`reason`/`clean`/`duration_ms` on disconnect, `delay_ms`/`attempt` on
  backoff). Typed columns (not an untyped `meta` blob) so the operator can
  query "this network's error disconnects" directly.

  Public API on `Grappa.SessionLog`; callers receive `%Event{}` structs by
  type. Wire projection lives in `Grappa.SessionLog.Wire`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  # Keep in sync with `Grappa.SessionLog.event/0` (the emit-side closed
  # set) — Ecto.Enum needs a compile-time literal list, so the set is
  # duplicated here; the cast rejects any unknown value at the persist
  # boundary, and the emit guard rejects it at the emit boundary.
  @events [:connected, :registered, :identified, :deidentified, :disconnected, :backoff]
  @subject_kinds [:user, :visitor]

  @type t :: %__MODULE__{
          id: integer() | nil,
          session_id: String.t() | nil,
          event: :connected | :registered | :identified | :deidentified | :disconnected | :backoff | nil,
          subject_kind: :user | :visitor | nil,
          network_id: integer() | nil,
          network_slug: String.t() | nil,
          nick: String.t() | nil,
          reason: String.t() | nil,
          clean: boolean() | nil,
          duration_ms: integer() | nil,
          delay_ms: integer() | nil,
          attempt: integer() | nil,
          at: DateTime.t() | nil
        }

  schema "session_log_events" do
    field :session_id, :string
    field :event, Ecto.Enum, values: @events
    field :subject_kind, Ecto.Enum, values: @subject_kinds
    field :network_id, :integer
    field :network_slug, :string
    field :nick, :string
    field :reason, :string
    field :clean, :boolean
    field :duration_ms, :integer
    field :delay_ms, :integer
    field :attempt, :integer
    field :at, :utc_datetime_usec
  end

  @permitted [
    :session_id,
    :event,
    :subject_kind,
    :network_id,
    :network_slug,
    :nick,
    :reason,
    :clean,
    :duration_ms,
    :delay_ms,
    :attempt,
    :at
  ]
  @required [:session_id, :event, :subject_kind, :network_id, :at]

  @doc """
  Builds an insert changeset from a `Grappa.SessionLog.emit/3` metadata
  map. The five common columns are required; event-specific extras cast
  through (nil when the event has none).
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(event, attrs) do
    event
    |> cast(attrs, @permitted)
    |> validate_required(@required)
  end
end
