defmodule Grappa.Push.BadgeCount do
  @moduledoc """
  PWA home-screen icon badge count — how many unread messages the
  subject chose to be notified about (2026-06-21).

  ## One number, one predicate

  `count/1` returns the number of unread scrollback rows that pass the
  REAL push-trigger predicate `Grappa.Push.Triggers.should_notify?/4`,
  capped at `99`. It is the EXACT same notify set Web Push fires on —
  by construction the badge and the OS notification never disagree.
  There is no new persisted state: the count is derived from the
  per-(subject, network, channel) read cursors
  (`Grappa.ReadCursor.bulk_for_subject/1`) and the unread tail
  (`Grappa.Scrollback.unread_content_tail/6`).

  ## Why reuse the predicate instead of a per-branch SQL COUNT

  The approved design sketched a SQL-COUNT fast path for the
  all/whitelist prefs branches and a fetch-and-verify path only for
  mentions. This module instead runs the SINGLE predicate over a bounded
  per-channel tail for EVERY branch. Rationale: a second, SQL-shaped copy
  of the notify logic is exactly the predicate-divergence bug class
  CLAUDE.md forbids ("one matcher, two consumers"). The cost is bounded —
  each window fetches at most `@per_channel_cap` rows and the fold
  early-bails once the running total reaches the badge cap — so the
  uniform path stays off any unbounded scan while keeping a single source
  of truth. Outbound DM rows (our own messages) are excluded by the
  predicate itself (`channel != own_nick`), so the tail needs no
  inbound/outbound split.

  ## own_nick is the CONFIGURED nick, off-Session (load-bearing)

  The mention branch of `should_notify?/4` needs the subject's IRC nick.
  This module resolves it from the configured credential nick (users) /
  `visitor.nick` (visitors) via `Networks.configured_nick_index/1` —
  NEVER the live `Session.current_nick/2`. `count/1` runs on the
  read-cursor settle hot path (door #3 fires on every focus-leave); a
  GenServer round-trip per network there is unacceptable, and `/me`
  already takes the same off-Session stance for its unread-count seed.
  Accepted staleness: after a `/nick` rename the mention match uses the
  configured nick until the next reconnect rewrites the credential. See
  DESIGN_NOTES 2026-06-21.

  ## Boundary — own boundary ABOVE Push, not inside it

  This module is namespaced under `Grappa.Push.*` for discoverability but
  declares its OWN `top_level?: true` boundary (same pattern as
  `Grappa.Visitors.Reaper` / `Grappa.Uploads.Reaper`). It CANNOT live in
  the `Grappa.Push` context boundary: it deps `Networks` / `ReadCursor` /
  `Visitors`, all of which transitively reach `Session`, and `Session`
  deps `Push` — so folding these into Push would close the cycle
  `Push → Networks → Session → Push`. Keeping BadgeCount in its own
  boundary that depends DOWN onto Push (for `Triggers.should_notify?/4`)
  inverts cleanly: nothing in the lower layers references BadgeCount.

  Door #1 (the push-payload badge) is the one caller that lives BELOW
  this layer (`Session → Push.Triggers`). It reaches `count/1` through a
  config-injected `Grappa.Push.BadgeSource` behaviour rather than a static
  reference, so Push never statically depends on BadgeCount (which would
  re-open the cycle). Doors #2/#3 call `count/1` directly from the web
  layer, which already sits above everything.
  """

  @behaviour Grappa.Push.BadgeSource

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Networks,
      Grappa.Push,
      Grappa.ReadCursor,
      Grappa.Scrollback,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.Visitors
    ]

  alias Grappa.{Networks, ReadCursor, Scrollback, Subject, UserSettings, Visitors}
  alias Grappa.Push.Triggers

  # Badge tops out at 99 — past that "99+" is the universal UI idiom and
  # the exact number stops mattering. The fold early-bails here so a
  # subject with thousands of unread mentions never scans past the cap.
  @badge_cap 99

  # Per-window fetch cap. A single channel can contribute at most this
  # many to the badge; combined with the 99 global cap it bounds the
  # whole fold to O(cap × cursored-channels) rows in the worst case, and
  # the early-bail makes the common case far cheaper.
  @per_channel_cap 100

  @doc """
  Returns the notify-worthy unread count for `subject`, in `0..99`.

  Folds over the subject's read cursors: for each cursored
  `(network, channel)` window it fetches the bounded unread content tail
  and counts the rows that pass `should_notify?/4` against the subject's
  notification prefs + highlight patterns. Channels with a `nil` cursor
  are skipped (same contract as the `/me` unread-count seed); cursors
  whose network slug no longer resolves to a credential / network row are
  skipped (stale cursor after a network delete). The running total
  early-bails at the cap.
  """
  @impl Grappa.Push.BadgeSource
  @spec count(Subject.t()) :: non_neg_integer()
  def count({_, _} = subject) do
    case ReadCursor.bulk_for_subject(subject) do
      empty when map_size(empty) == 0 ->
        0

      cursors ->
        prefs = UserSettings.get_notification_prefs(subject)
        patterns = UserSettings.get_highlight_patterns(subject)
        windows = resolve_windows(subject)

        cursors
        |> flatten_entries(windows)
        |> Enum.reduce_while(0, &accumulate(&1, &2, subject, prefs, patterns))
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # One fold step: add the window's notify-worthy unread count, early-bail
  # at the badge cap. Lifted out of `count/1`'s reduce_while closure to
  # keep that body shallow (credo nesting depth).
  @spec accumulate(
          {integer(), String.t(), integer(), String.t()},
          non_neg_integer(),
          Subject.t(),
          UserSettings.notification_prefs(),
          [String.t()]
        ) :: {:cont, non_neg_integer()} | {:halt, non_neg_integer()}
  defp accumulate({network_id, channel, cursor, own_nick}, acc, subject, prefs, patterns) do
    acc = acc + count_window(subject, network_id, channel, cursor, own_nick, prefs, patterns)

    if acc >= @badge_cap, do: {:halt, @badge_cap}, else: {:cont, acc}
  end

  # Flattens the nested cursor envelope into a list of
  # `{network_id, channel, cursor, own_nick}` work items, dropping:
  #   * slugs absent from `windows` (stale cursor / deleted network /
  #     no credential on that network), and
  #   * `nil` cursors (legacy explicit-no-cursor rows — same skip the
  #     `/me` unread-count seed applies).
  @spec flatten_entries(ReadCursor.bulk_envelope(), %{String.t() => {integer(), String.t()}}) ::
          [{integer(), String.t(), integer(), String.t()}]
  defp flatten_entries(cursors, windows) do
    for {slug, per_channel} <- cursors,
        {:ok, {network_id, own_nick}} <- [Map.fetch(windows, slug)],
        {channel, cursor} <- per_channel,
        is_integer(cursor) do
      {network_id, channel, cursor, own_nick}
    end
  end

  @spec count_window(
          Subject.t(),
          integer(),
          String.t(),
          integer(),
          String.t(),
          UserSettings.notification_prefs(),
          [String.t()]
        ) :: non_neg_integer()
  defp count_window(subject, network_id, channel, cursor, own_nick, prefs, patterns) do
    subject
    |> Scrollback.unread_content_tail(network_id, channel, cursor, own_nick, @per_channel_cap)
    |> Enum.count(&Triggers.should_notify?(&1, own_nick, prefs, patterns))
  end

  # `%{slug => {network_id, configured_own_nick}}` for the subject.
  # Users: one joined credentials⋈networks query. Visitors: the single
  # `(network_slug, nick)` the visitor row carries, resolved to a
  # network_id via the slug index (empty map when the visitor or its
  # network is gone).
  @spec resolve_windows(Subject.t()) :: %{String.t() => {integer(), String.t()}}
  defp resolve_windows({:user, user_id}), do: Networks.configured_nick_index(user_id)

  defp resolve_windows({:visitor, visitor_id}) do
    case Visitors.get(visitor_id) do
      nil ->
        %{}

      visitor ->
        case Map.fetch(Networks.network_id_by_slug_index(), visitor.network_slug) do
          {:ok, network_id} -> %{visitor.network_slug => {network_id, visitor.nick}}
          :error -> %{}
        end
    end
  end
end
