defmodule Grappa.ReadCursor do
  @moduledoc """
  Server-owned per-(subject, network, channel) read cursor.

  ## Semantics

  The cursor is "the newest row the operator has read". cic POSTs
  `set/4` on every settle event — focus-leave, browser-blur,
  scroll-settle, scroll-to-bottom tap. The write is **monotonic
  (advance-only)**: a POST carrying an id at or below the stored cursor
  is a no-op that returns the existing (higher) cursor unchanged. A
  lower id is never a deliberate backward move — it is a stale POST
  racing a slow message-page load (see #233 / DESIGN_NOTES 2026-07-14),
  and writing it backward would fan a `read_cursor_set` broadcast that
  snaps every device's view back to the old read marker. cic is already
  forward-only locally; the server is the single authoritative regressor,
  so the clamp lives here. Cross-device fan-out via `broadcast_set/4`
  keeps every open device aligned on the same position.

  **Deliberate mark-as-unread** (the one legitimate backward move) has
  no caller today — no cic surface, no REST verb. It is intentionally
  NOT supported through `set/4`: when the feature ships it gets its OWN
  explicit path that bypasses the monotonic guard, added THEN with its
  caller (YAGNI — do not relax this guard to `<` to pre-empt it).

  Surfaces consuming the cursor:

    * cic in-pane unread-marker: rows with `id > cursor` are unread.
    * cic sidebar/bottom-bar badge counters: same predicate.
    * Phase 6 IRCv3 listener facade: `+draft/read-marker` MARKREAD
      lines reflect the same `last_read_message_id`.

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
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Networks, Grappa.PubSub, Grappa.Repo, Grappa.Scrollback],
    # `Visitors.Visitor` is referenced by `ReadCursor.Cursor` (the
    # `belongs_to :visitor` association) in struct-only form.
    # Mirrors Scrollback's identical handling — see
    # `Grappa.Scrollback`'s `dirty_xrefs` rationale: the FK reference
    # carries no behaviour we'd want Boundary to gate.
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Cursor, Wire]

  import Ecto.Query

  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic
  alias Grappa.ReadCursor.{Cursor, Wire}
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

  Nested matches the Phoenix per-channel topic shape
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
    # UX-4 bucket A — canonicalise channel at the read boundary so a
    # cic-side `#Chan` lookup hits the canonical `#chan` cursor row.
    # Sigil-aware; nick-shape DM windows pass through unchanged.
    channel = Grappa.IRC.Identifier.canonical_channel(channel)

    Cursor
    |> subject_filter(subject)
    |> where([c], c.network_id == ^network_id and c.channel == ^channel)
    |> Repo.one()
  end

  @doc """
  Sets the cursor for `(subject, network_id, channel)` to `message_id`.

  **Monotonic (advance-only).** The cursor represents "the newest row
  the operator has read"; cic POSTs on every settle (focus-leave,
  browser-blur, scroll-settle, scroll-to-bottom tap). A POST whose
  `message_id` is at or below the current cursor is a no-op and returns
  the existing (higher) cursor unchanged — never a backward write. A
  lower id is a stale POST racing a slow message-page load (#233), not
  a deliberate move; writing it backward regressed the cursor and the
  `broadcast_set/4` fan-out snapped every device's view to the old read
  marker. Deliberate mark-as-unread has no caller today and, when built,
  gets its own explicit backward path (see moduledoc).

  Validation:

    * `message_id` MUST exist in `messages` AND belong to the same
      `(subject, network_id, channel)` triple — otherwise returns
      `{:error, :invalid_message}`.
    * Subject XOR enforced by changeset.

  Returns `{:ok, %Cursor{}}` on insert / advance / clamped no-op; the
  returned struct always reflects the post-call state (on a stale lower
  POST that is the current, higher cursor). `{:error, _}` on validation
  failure (`:invalid_message` for FK / iso violation,
  `Ecto.Changeset.t()` for changeset-level errors).

  No broadcast is performed here — `broadcast_set/4` is a separate
  step the caller invokes after a successful set, so tests + bulk
  paths can decide whether a fan-out is appropriate.
  """
  @spec set(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, :invalid_message | Ecto.Changeset.t()}
  def set(subject, network_id, channel, message_id)
      when is_integer(network_id) and is_binary(channel) and channel != "" and
             is_integer(message_id) and message_id > 0 do
    # UX-4 bucket A — canonicalise once at the entry boundary so every
    # downstream call (`message_belongs?/4` validator + `do_set/4`
    # → `get/3` + `Cursor.changeset/2`) observes the canonical key.
    channel = Grappa.IRC.Identifier.canonical_channel(channel)

    if message_belongs?(subject, network_id, channel, message_id) do
      do_set(subject, network_id, channel, message_id)
    else
      {:error, :invalid_message}
    end
  end

  @doc """
  Returns every cursor for `subject`, grouped by network slug then
  channel.

  Shape: `%{network_slug => %{channel => last_read_message_id}}` —
  nested envelope.

  Used at `/me` envelope assembly time. Single LEFT JOIN to `networks`
  for slug resolution; one row per cursor; bounded by ~600 rows in the
  worst case (~20 networks * ~30 channels).
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

      %{kind: "read_cursor_set", last_read_message_id: <integer>,
        badge_count: <integer>}

  Cross-device sync: every live cic instance subscribed to the
  per-channel topic receives the event and updates its cursor signal
  map. Emit on every `set/4`, no batching, no throttle.

  `badge_count` (PWA icon badge door #3, 2026-06-21) is the
  notify-worthy unread total AFTER this advance — the caller computes it
  (it holds the subject; `ReadCursor` deliberately does NOT depend on
  `Grappa.Push.BadgeCount`, which sits a layer above) and passes it in so
  every listening client refreshes its icon badge / `document.title`
  without a `/me` round-trip.

  The caller is responsible for resolving `user_name` + `network_slug`
  from the subject — the broadcast topic is user-rooted (per CLAUDE.md
  "PubSub topic naming") and ReadCursor's API is subject-rooted
  (`{:user, uuid}` / `{:visitor, uuid}`), so the translation happens at
  the call site where both are already in scope. Visitor callers pass
  `"visitor:" <> visitor.id` as the user-name segment — same shape
  `UserSocket` uses for the visitor's user-rooted topic tree (V4
  visitor-parity, 2026-05-15).
  """
  @spec broadcast_set(String.t(), String.t(), String.t(), integer(), non_neg_integer()) ::
          :ok | {:error, term()}
  def broadcast_set(user_name, network_slug, channel, last_read_message_id, badge_count)
      when is_binary(user_name) and is_binary(network_slug) and is_binary(channel) and
             is_integer(last_read_message_id) and is_integer(badge_count) do
    topic = Topic.channel(user_name, network_slug, channel)

    Grappa.PubSub.broadcast_event(
      topic,
      Wire.read_cursor_set(last_read_message_id, badge_count)
    )
  end

  @doc """
  Test-support: drains every read-cursor row for `user_id` in a single
  DELETE. Intended for `Grappa.TestSupport.SubjectReset` only — production
  cursor lifecycle is per-channel via `set/4`.
  """
  @spec clear_all_for_user(Ecto.UUID.t()) :: :ok
  def clear_all_for_user(user_id) when is_binary(user_id) do
    query = from(c in Cursor, where: c.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec do_set(subject(), integer(), String.t(), integer()) ::
          {:ok, Cursor.t()} | {:error, Ecto.Changeset.t()}
  defp do_set(subject, network_id, channel, message_id) do
    case get(subject, network_id, channel) do
      # Monotonic clamp (#233): `set/4` is advance-only. Any id at or
      # below the stored cursor is a no-op that returns the EXISTING
      # (higher-or-equal) cursor unchanged — this subsumes the old
      # equal-id no-op (equal is just the `<=` boundary) AND rejects the
      # stale/lower POST that used to regress the cursor. A stale lower
      # id arrives when cic taps scroll-to-bottom during a ~1.5s
      # message-page load and the currently-loaded bottom (near the old
      # read marker) POSTs before the newest page lands; last-write-wins
      # wrote it backward and the `read_cursor_set` broadcast snapped
      # every view back ~2s later (see moduledoc "Monotonic advance").
      # Deliberate mark-as-unread has no caller today; when built it gets
      # its OWN explicit backward path — do NOT relax this to `<`.
      %Cursor{last_read_message_id: current} = cursor when message_id <= current ->
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
    # UX-6 bucket K (2026-05-21) — share `Scrollback.channel_or_dm_where/3`
    # with the read path so cursor validation and scrollback fetch agree
    # on the "what counts as a row in this window" predicate. Pre-K this
    # function used a literal `m.channel == ^channel` filter; inbound
    # DMs (`channel = own_nick, dm_with = peer`) failed validation when
    # cic POSTed the cursor for the peer's query window, so the in-pane
    # unread-marker never cleared on focus. Outbound DMs (`channel = peer`)
    # passed, which is why "sending a message to the peer cleared the
    # marker." Single shared predicate closes the divergence class.
    #
    # `own_nick: nil` — cic's `POST /networks/:slug/channels/:chan/read-cursor`
    # doesn't carry own_nick (it would be redundant since the row
    # existence check is symmetric for either direction). For an own-nick
    # query window, the OR-shape over-matches every peer DM whose
    # `dm_with == own_nick`, but `Repo.exists?` only needs ONE matching
    # row from the same subject to validate the cursor — the precise
    # narrowing is a read-time concern (scrollback display), not a
    # write-time concern (cursor validity).
    Message
    |> subject_filter(subject)
    |> where([m], m.id == ^message_id and m.network_id == ^network_id)
    |> Grappa.Scrollback.channel_or_dm_where(channel, nil)
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
