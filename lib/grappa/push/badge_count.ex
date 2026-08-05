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

  The notify predicate gates on `Grappa.Scrollback.Message.notify_kinds/0`
  (`:privmsg`, `:action`) — the notify-worthy SUBSET of the unread-content
  kinds `Grappa.WindowCounts.snapshot/7` counts. Both derive from ONE
  projection declaration (#395), so this badge total is a subset of the
  per-window unread message counts BY CONSTRUCTION: a `:notice` counts as
  unread but never reaches this badge.

  ## Approximate above the cap — a deliberate, documented rule (#395)

  The badge is EXACT up to `99` and APPROXIMATE above it: `count/1`
  early-bails at `@badge_cap` (99) and each window folds at most
  `@per_channel_cap` (100) rows, so a subject with thousands of unread
  notify-worthy messages reports `99`, not the true total. The per-window
  unread MESSAGE count (`Grappa.WindowCounts.snapshot/7`'s `messages`
  field, off `Scrollback.count_after_split/6`) is by contrast EXACT and
  unbounded. This asymmetry is intentional, not an oversight: the badge
  answers "roughly how many notify-worthy — capped, because the UI renders
  `99+`", the window count answers "exactly how many new". Past the cap the
  exact badge value is immaterial (the glyph is `99+`), and removing the
  cap would re-introduce the unbounded per-window scan the cap exists to
  bound — a performance regression #395 explicitly refuses to make. The
  per-window MENTION count (`WindowCounts` `mentions`) is bounded the same
  way (`@mention_scan_cap`), for the same reason.

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
  predicate itself — `should_notify?/4` returns `false` for any row whose
  `sender` folds to the live own_nick (#532 C), an IDENTITY test that
  covers both self-authored shapes. It is NOT `channel != own_nick`:
  outbound DMs are persisted with `channel = peer`, which passes that test
  and would route them into the mention branch (the #532 C bug — the
  earlier wording of this note asserted the opposite of the real code).

  ## own_nick is the LIVE nick, via a cheap Registry lookup (#498)

  The mention branch of `should_notify?/4` needs the subject's IRC nick.
  This module resolves it via `Networks.live_nick_index/1`, which reads the
  LIVE session nick through `Session.current_nick/2` — now a cheap
  `Registry` value lookup, NOT a `GenServer.call`. `count/1` runs on the
  read-cursor settle hot path (door #3 fires on every focus-leave), and the
  `/me` unread-count seed shares the same resolver on cold-load; both are
  hot enough that the ORIGINAL design read the configured credential nick
  off-`Session` to dodge a per-network GenServer round-trip. But nothing
  rewrites a user's credential nick after a `/nick`, so that shortcut went
  permanently stale — matching the OLD nick and missing the new. Reading
  the live nick is now free, so the count follows a rename immediately,
  both halves. See DESIGN_NOTES 2026-07-28 (retiring the 2026-06-21
  accepted-staleness tradeoff).

  ## Boundary — own boundary ABOVE Push, not inside it

  This module is namespaced under `Grappa.Push.*` for discoverability but
  declares its OWN `top_level?: true` boundary (same pattern as
  `Grappa.Visitors.Reaper` / `Grappa.Uploads.Reaper`). It CANNOT live in
  the `Grappa.Push` context boundary: it deps `Networks` / `ReadCursor` /
  `Scrollback`, which transitively reach `Session`, and `Session`
  deps `Push` — so folding these into Push would close the cycle
  `Push → Networks → Session → Push`. Keeping BadgeCount in its own
  boundary that depends DOWN onto Push (for `Triggers.should_notify?/4`)
  inverts cleanly: nothing in the lower layers references BadgeCount.

  #211 phase 6 — the visitor own-nick seed moved off `Grappa.Visitors`
  (the singular `visitor.network_slug`/`visitor.nick` scalar) onto the
  subject-polymorphic `Networks.live_nick_index/1` (per-credential, multi-
  network). So this module no longer deps `Grappa.Visitors` at all — the
  per-network LIVE nick for BOTH subjects comes from `Networks` (#498).

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
      Grappa.UserSettings
    ]

  alias Grappa.{Networks, ReadCursor, Scrollback, Subject, UserSettings}
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
        windows = live_nick_windows(subject)

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

  @doc """
  `%{slug => {network_id, live_own_nick}}` for the subject — the per-network
  LIVE IRC nick (live session nick, falling back to the configured
  credential nick when no session is up), via `Networks.live_nick_index/1`.

  The shared own-nick resolver behind BOTH notify-count doors: this
  module's badge count AND the `/me` unread-count seed
  (`GrappaWeb.MeController.build_unread_counts/2`, S2 2026-07-08 review),
  plus the read-cursor settle recompute (`ReadCursorController`). All narrow
  the own-nick query window (`channel == own_nick`) so inbound DMs don't
  over-count, and all read the ONE live-nick source. #498 converged them
  off the former off-`Session` CONFIGURED-nick shortcut — which went
  permanently stale after a `/nick` (nothing rewrites a user's credential
  nick) — now that `Session.current_nick/2` is a cheap `Registry` lookup
  rather than a per-network `GenServer.call`. Subject-polymorphic (users +
  #211-phase-6 multi-network visitors) via one credentials⋈networks query.
  See the moduledoc + DESIGN_NOTES 2026-07-28.
  """
  @spec live_nick_windows(Subject.t()) :: %{String.t() => {integer(), String.t()}}
  def live_nick_windows({_, _} = subject), do: Networks.live_nick_index(subject)
end
