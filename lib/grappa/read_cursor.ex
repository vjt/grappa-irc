defmodule Grappa.ReadCursor do
  @moduledoc """
  Server-owned per-(subject, network, channel) read cursor — the
  primitive that lets cicchetto sync read state across devices, recover
  from the cp13-S5 subscribe-after-broadcast race, and gives the Phase 6
  IRCv3 listener facade a `+draft/read-marker` source without redesign.

  ## Why this exists

  The Phase 1 invariant *"No server-side `MARKREAD` / read cursors"* is
  deliberately flipped in the `server-side-read-state` cluster. See
  `docs/DESIGN_NOTES.md` "2026-05-13 — invariant flip" and
  `docs/plans/2026-05-13-server-side-read-state.md` for the full
  motivation.

  ## Forward-only advance

  `advance/4` is idempotent: if the existing `last_read_message_id` is
  already greater than or equal to the requested `message_id`, the call
  is a no-op and returns the existing row. This gives every callsite
  the same shape — clients can fire-and-forget cursor advances on every
  read event without bookkeeping.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message`'s convention. The subject
  discriminated union (`{:user, uuid}` | `{:visitor, uuid}`) is the
  same tagged-tuple shape Scrollback's `fetch/6` accepts. Same predicate
  helpers (`subject_filter/1`, `subject_attrs/1`) keep the per-subject
  iso boundary uniform across contexts.

  ## Boundary

  Standalone context. Its only deps are:

    * `Grappa.Repo` — persistence.
    * `Grappa.Accounts` — `User` association (FK reference only).
    * `Grappa.Networks` — `Network` association (FK reference only) +
      `Network.slug/1` for the `bulk_for_subject/1` envelope grouping.
    * `Grappa.Visitors` — `Visitor` association (FK reference only).
    * `Grappa.Scrollback` — `Message` association (FK reference only)
      + `Message.t()` typespec; existence validation queries the
      `messages` table by id.
    * `Grappa.PubSub` — `Topic.channel/3` for the `read_cursor_set`
      cross-device broadcast.

  The `Cursor` schema module is internal; callers receive `%Cursor{}`
  structs by type but MUST NOT alias or import the schema module
  directly.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.PubSub, Grappa.Repo, Grappa.Scrollback],
    # `Visitors.Visitor` is referenced by `ReadCursor.Cursor` (the
    # `belongs_to :visitor` association) in struct-only form.
    # Mirrors Scrollback's identical handling — see
    # `Grappa.Scrollback`'s `dirty_xrefs` rationale: the FK reference
    # carries no behaviour we'd want Boundary to gate.
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Cursor]

  import Ecto.Query

  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic
  alias Grappa.ReadCursor.Cursor
  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  @typedoc """
  Subject discriminator — mirrors `t:Grappa.Scrollback.subject/0`. Same
  tagged-tuple shape across both contexts so callers don't need to
  re-encode the principal at every boundary.
  """
  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @typedoc """
  Bulk envelope shape: nested `%{network_slug => %{channel => message_id}}`.

  Per plan O1: nested matches the Phoenix per-channel topic shape
  (network grouping is the natural axis of the wire) and the size is
  bounded by network count. Loaded once at subject login by `MeController`
  / equivalent envelope assembler.
  """
  @type bulk_envelope :: %{String.t() => %{String.t() => integer()}}

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Returns the cursor row for `(subject, network_id, channel)`, or `nil`
  if no cursor exists yet. Single index hit via the partial unique index
  on the matching subject branch.
  """
  @spec get(subject(), integer(), String.t()) :: Cursor.t() | nil
  def get(subject, network_id, channel)
      when is_integer(network_id) and is_binary(channel) and channel != "" do
    Cursor
    |> subject_filter(subject)
    |> where([c], c.network_id == ^network_id and c.channel == ^channel)
    |> Repo.one()
  end

  @doc """
  Advances the cursor for `(subject, network_id, channel)` to
  `message_id`.

  Forward-only: if a cursor already exists and its
  `last_read_message_id` is `>= message_id`, returns `{:ok, existing}`
  without DB mutation. If no cursor exists, inserts one. If the existing
  cursor's id is lower, updates in place.

  Validation:

    * `message_id` MUST exist in `messages` AND belong to the same
      `(subject, network_id, channel)` triple — otherwise returns
      `{:error, :invalid_message}`.
    * Subject XOR enforced by changeset.

  Returns `{:ok, %Cursor{}}` on advance / no-op / insert; the returned
  struct always reflects the post-call state. `{:error, _}` on
  validation failure (`:invalid_message` for FK / iso violation,
  `Ecto.Changeset.t()` for changeset-level errors).

  No broadcast is performed here — `broadcast_advance/3` is a separate
  step the caller invokes after a successful advance, so tests + bulk
  paths can decide whether a fan-out is appropriate.
  """
  @spec advance(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, :invalid_message | Ecto.Changeset.t()}
  def advance(subject, network_id, channel, message_id)
      when is_integer(network_id) and is_binary(channel) and channel != "" and
             is_integer(message_id) and message_id > 0 do
    if message_belongs?(subject, network_id, channel, message_id) do
      do_advance(subject, network_id, channel, message_id)
    else
      {:error, :invalid_message}
    end
  end

  @doc """
  Returns every cursor for `subject`, grouped by network slug then
  channel.

  Shape: `%{network_slug => %{channel => last_read_message_id}}` —
  per plan O1 (nested envelope).

  Used at `/me` envelope assembly time. Single LEFT JOIN to `networks`
  for slug resolution; one row per cursor; bounded by ~600 rows in the
  worst case (~20 networks * ~30 channels) per plan O5.
  """
  @spec bulk_for_subject(subject()) :: bulk_envelope()
  def bulk_for_subject(subject) do
    base =
      from(c in Cursor,
        join: n in Network,
        on: n.id == c.network_id,
        select: {n.slug, c.channel, c.last_read_message_id}
      )

    base
    |> subject_filter(subject)
    |> Repo.all()
    |> Enum.reduce(%{}, fn {slug, channel, id}, acc ->
      Map.update(acc, slug, %{channel => id}, &Map.put(&1, channel, id))
    end)
  end

  @doc """
  Broadcasts a typed `read_cursor_set` event on the per-channel topic
  for `(user_name, network_slug, channel)`.

  Payload shape:

      %{kind: "read_cursor_set", last_read_message_id: <integer>}

  Cross-device sync: every live cic instance subscribed to the
  per-channel topic receives the event and updates its cursor signal
  map. Per plan O6 — emit on every advance, no batching, no throttle.

  The caller is responsible for resolving `user_name` + `network_slug`
  from the subject — the broadcast topic is user-rooted (per CLAUDE.md
  "PubSub topic naming") and ReadCursor's API is subject-rooted
  (`{:user, uuid}` / `{:visitor, uuid}`), so the translation happens at
  the call site where both are already in scope.

  Visitor sessions don't have a stable user_name → no broadcast surface
  for them; visitor cursors are still persisted but the cross-device
  sync mechanism isn't applicable (visitor sessions are single-device
  by construction).
  """
  @spec broadcast_advance(String.t(), String.t(), String.t(), integer()) :: :ok
  def broadcast_advance(user_name, network_slug, channel, last_read_message_id)
      when is_binary(user_name) and is_binary(network_slug) and is_binary(channel) and
             is_integer(last_read_message_id) do
    topic = Topic.channel(user_name, network_slug, channel)

    Grappa.PubSub.broadcast_event(topic, %{
      kind: "read_cursor_set",
      last_read_message_id: last_read_message_id
    })
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec do_advance(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, Ecto.Changeset.t()}
  defp do_advance(subject, network_id, channel, message_id) do
    case get(subject, network_id, channel) do
      %Cursor{last_read_message_id: existing_id} = cursor when existing_id >= message_id ->
        {:ok, cursor}

      %Cursor{} = cursor ->
        cursor
        |> Cursor.changeset(%{last_read_message_id: message_id})
        |> Repo.update()

      nil ->
        attrs =
          Map.merge(subject_attrs(subject), %{
            network_id: network_id,
            channel: channel,
            last_read_message_id: message_id
          })

        %Cursor{}
        |> Cursor.changeset(attrs)
        |> Repo.insert()
    end
  end

  @spec message_belongs?(subject(), integer(), String.t(), pos_integer()) :: boolean()
  defp message_belongs?(subject, network_id, channel, message_id) do
    Message
    |> subject_filter(subject)
    |> where([m], m.id == ^message_id and m.network_id == ^network_id and m.channel == ^channel)
    |> Repo.exists?()
  end

  # Mirrors `Grappa.Scrollback.subject_where/2` — same tagged-tuple
  # discriminator, same `m.user_id` / `m.visitor_id` partition. Reused
  # across `Cursor` queries (binding name `c`) and `Message` existence
  # queries (binding name `m`); Ecto's binding-by-position lookup
  # works on both since each query has a single from-binding.
  @spec subject_filter(Ecto.Queryable.t(), subject()) :: Ecto.Query.t()
  defp subject_filter(queryable, {:user, user_id}) when is_binary(user_id) do
    where(queryable, [row], row.user_id == ^user_id)
  end

  defp subject_filter(queryable, {:visitor, visitor_id}) when is_binary(visitor_id) do
    where(queryable, [row], row.visitor_id == ^visitor_id)
  end

  @spec subject_attrs(subject()) :: %{atom() => Ecto.UUID.t()}
  defp subject_attrs({:user, user_id}), do: %{user_id: user_id}
  defp subject_attrs({:visitor, visitor_id}), do: %{visitor_id: visitor_id}
end
