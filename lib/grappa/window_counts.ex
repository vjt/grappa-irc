defmodule Grappa.WindowCounts do
  @moduledoc """
  Server-authoritative per-window unread/mention/severity snapshot (#267).

  ## Derive, don't duplicate

  `snapshot/7` computes `%{messages, mentions, events, severity}` for a
  `(subject, network, channel)` window PURELY from the read cursor
  (`Grappa.ReadCursor`) + the `messages` table. There is NO persisted
  counter and NO per-channel state in `Session.Server` — the count is
  a function of `(cursor, rows)`, so it is always correct, reconstructs
  identically on reconnect, and stays consistent across a subject's
  tabs/devices (CLAUDE.md design-discipline rule 1). cic renders the
  snapshot; it never computes counts from the raw event stream.

  ## The three counts

    * `messages` — unread CONTENT rows (`:privmsg | :notice | :action`),
      the same set `Scrollback.count_after_split/6` buckets as
      `:messages`. Unbounded (exact) — a channel with 10k unread must
      surface 10k, matching `count_after/6`.
    * `events` — unread PRESENCE/CONTROL rows (`:join | :part | :quit |
      :nick_change | :mode | :topic | :kick | :server_event`). #265: this
      is a SEPARATE low tier — presence churn never inflates the message
      or mention count.
    * `mentions` — the subset of unread content rows that mention the
      subject, via the SSOT predicate `Grappa.Mentions.mentioned?/3`
      (own_nick ∪ highlight patterns, word-boundary, case-insensitive).
      Own-sent rows are excluded (you cannot mention yourself), folding
      `sender` through the ASCII nick SSOT (#121/#525). Bounded by
      `@mention_scan_cap` — the same bounded-tail strategy
      `Grappa.Push.BadgeCount` uses (SQLite has no `REGEXP`, so the
      match runs in-memory over a capped content tail).

  ## Severity ladder

  `mention > message > event > none`. A window with any mention is
  `:mention`; else with any message `:message`; else with any presence
  event `:event`; else `:none`. The aggregate/overflow badge derives its
  colour from the max severity across hidden windows (client projection).

  ## Reuse, explicit own_nick

  `snapshot/7` takes `own_nick` + `patterns` as explicit args — it does
  NOT reach into `Session.Server`. Callers resolve them the same way the
  existing count doors do: the LIVE nick (`Push.BadgeCount.live_nick_windows/1`,
  a cheap `Registry` lookup) for `/me`, the live `state.nick` for the
  per-message push, and `UserSettings.get_highlight_patterns/1` for
  patterns. #498 converged the `/me` seed onto the live nick so the count
  follows a `/nick` immediately (see DESIGN_NOTES 2026-07-28).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Mentions, Grappa.ReadCursor, Grappa.Scrollback, Grappa.Subject],
    exports: [PushSource, Wire]

  alias Grappa.IRC.Identifier
  alias Grappa.{Mentions, ReadCursor, Scrollback, Subject}

  @typedoc """
  Window severity, high to low. `:mention` = at least one unread
  highlight; `:message` = unread content but no highlight; `:event` =
  only unread presence/control churn (#265 low tier); `:none` = read
  up to tail. Closed atom set — cic mirrors as a literal TS union via
  `mix grappa.gen_wire_types`.
  """
  @type severity :: :mention | :message | :event | :none

  @typedoc """
  Per-window count snapshot. `messages` is exact (unbounded);
  `mentions` is bounded by the scan cap (`@mention_scan_cap`) — so it is
  APPROXIMATE above the cap while `messages` stays EXACT. That asymmetry is
  a deliberate, documented rule, not an oversight: it mirrors the PWA badge
  cap (`Grappa.Push.BadgeCount`, "Approximate above the cap" — #395). Past
  the cap the exact `mentions` value is immaterial (cic renders `@N`), and
  removing the cap would re-introduce the unbounded in-memory regex scan it
  exists to bound.
  """
  @type t :: %{
          messages: non_neg_integer(),
          mentions: non_neg_integer(),
          events: non_neg_integer(),
          severity: severity()
        }

  # Per-window mention scan cap. Mirrors `BadgeCount.@per_channel_cap` —
  # a single window contributes at most this many to the mention badge,
  # keeping the in-memory regex off an unbounded scan. Past the cap the
  # exact number stops mattering (the badge renders "@N").
  @mention_scan_cap 100

  @doc """
  The all-zero snapshot (`severity: :none`). Used for the unresolvable
  join-reply fall-through (deleted user / missing network / no session) so
  cic renders a zero badge instead of branching on a missing map.
  """
  @spec zero() :: %{messages: 0, mentions: 0, events: 0, severity: :none}
  def zero, do: %{messages: 0, mentions: 0, events: 0, severity: :none}

  @doc """
  Returns the `%{messages, mentions, events, severity}` snapshot for the
  `(subject, network_id, channel)` window relative to `cursor`
  (`last_read_message_id`; `nil` counts from the beginning).

  `own_nick`, `patterns` and `hide_presence` are REQUIRED positionals — no
  defaulting wrapper (same rule as `Scrollback.count_after/6`): a default
  silently re-opens the CP14-B3 own-nick DM over-count and the mention-fold
  hazard. `own_nick` MAY be `nil` for the unbound-but-retained network
  case (`/me` seed for a network the subject holds no credential on) —
  there is then no nick to match, so `mentions` is `0` and messages/events
  fall back to `count_after_split/6`'s channel-shape narrowing. Live
  doors (`join_reply`, per-message push) always pass a real nick.

  ## `hide_presence` (#505)

  Resolved by the caller through `Grappa.PresenceFilter.Resolver.hidden?/4`
  — this module deliberately does not reach for prefs or a live member
  count, the same way it does not reach into `Session.Server` for the nick.
  When true, `events` drops the narrow suppressed presence kinds, which can
  take `severity` off the ladder entirely: a window whose only unread is
  hidden churn is `:none`, not `:event`. That is the point — a faint badge
  the operator cannot clear by reading is worse than no badge.
  """
  @spec snapshot(
          Subject.t(),
          integer(),
          String.t(),
          integer() | nil,
          String.t() | nil,
          [String.t()],
          boolean()
        ) :: t()
  def snapshot(subject, network_id, channel, cursor, own_nick, patterns, hide_presence)
      when is_integer(network_id) and (is_integer(cursor) or is_nil(cursor)) and
             (is_binary(own_nick) or is_nil(own_nick)) and is_list(patterns) and
             is_boolean(hide_presence) do
    after_id = cursor || 0

    %{messages: messages, events: events} =
      Scrollback.count_after_split(
        subject,
        network_id,
        channel,
        after_id,
        own_nick,
        hide_presence
      )

    mentions = count_mentions(subject, network_id, channel, after_id, own_nick, patterns)

    %{
      messages: messages,
      mentions: mentions,
      events: events,
      severity: severity(messages, mentions, events)
    }
  end

  @doc """
  #396 — the WHOLE subject's per-window snapshot map in a CONSTANT number of
  queries (2), independent of window count. Replaces the cold-load
  (`MeController.build_unread_counts/2`) N × `snapshot/7` fan-out (~2 queries
  per window, ~100 round trips at a ~50-window logon).

  Returns the SAME nested shape the per-window loop built —
  `%{network_slug => %{channel => t()}}` — so `/me`'s `unread_counts`
  envelope is byte-identical for channel + DM-peer windows (the own-nick
  SELF window count changes by design; see `ReadCursor.bulk_unread_split/3`
  and DESIGN_NOTES 2026-07-25). The subject's own presence rows are excluded
  from `events` (#532 A) — the `own_nicks` threaded below drives that.

  Two bulk reads, both driven by the read cursors (#393's single
  `nick_fold(COALESCE(dm_with, channel))` predicate unifies channel + DM
  windows into one join condition, served by the live prod indexes):

    1. `ReadCursor.bulk_unread_split/3` — every window's `%{messages,
       events}` in one grouped statement (zero-unread windows included,
       nil-cursor windows skipped; own presence rows excluded from `events`
       via `own_nicks`, #532 A);
    2. `ReadCursor.bulk_unread_content_tails/2` — every window's capped
       unread content tail in one statement; the mention fold
       (`Mentions.mentioned?/3`, not expressible in SQL) then runs in Elixir
       per window, grouped by channel, exactly as `count_mentions/6` does
       per window.

  `own_nicks` (`%{slug => {network_id, own_nick}}`, the LIVE nick via
  `Push.BadgeCount.live_nick_windows/1`) and `patterns` (subject-wide
  highlight list) are resolved ONCE by the caller and threaded in — #498
  converged this onto the live nick (cheap `Registry` lookup) so the
  mention fold follows a `/nick`. A slug with no resolvable nick
  (`nil` own_nick, unbound-but-retained network) folds to `mentions: 0`,
  the messages/events still counting — mirrors `snapshot/7`'s nil own_nick.

  ## `hidden_channels` (#505)

  `%{network_slug => MapSet.of(channel)}`, resolved ONCE by the caller via
  `Grappa.PresenceFilter.Resolver.hidden_channels/3` and pushed down into
  the single split statement — the per-window `events` exclusion rides the
  existing join condition, so a subject with 50 hiding windows still costs
  the same two queries. This is the door the #505 symptom is actually
  reported through: a channel never opened this session is seeded here, not
  by `snapshot/7`.

  An empty map means "nothing hides", and the exclusion term is then not
  built at all — the statement is byte-identical to the pre-#505 one.
  """
  @spec bulk_snapshot(
          Subject.t(),
          %{String.t() => {integer(), String.t()}},
          [String.t()],
          %{String.t() => MapSet.t(String.t())}
        ) :: %{String.t() => %{String.t() => t()}}
  def bulk_snapshot(subject, own_nicks, patterns, hidden_channels)
      when is_map(own_nicks) and is_list(patterns) and is_map(hidden_channels) do
    counts = ReadCursor.bulk_unread_split(subject, own_nicks, hidden_channels)
    tails = ReadCursor.bulk_unread_content_tails(subject, @mention_scan_cap)

    Map.new(counts, fn {slug, per_channel} ->
      own_nick = own_nick_for_slug(own_nicks, slug)
      slug_tails = Map.get(tails, slug, %{})

      windows =
        Map.new(per_channel, fn {channel, %{messages: messages, events: events}} ->
          mentions = count_tail_mentions(Map.get(slug_tails, channel, []), own_nick, patterns)

          {channel,
           %{
             messages: messages,
             mentions: mentions,
             events: events,
             severity: severity(messages, mentions, events)
           }}
        end)

      {slug, windows}
    end)
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # Configured own-nick for `slug`, or `nil` when the subject holds no
  # credential there (unbound-but-retained network). Mirrors
  # `MeController.own_nick_for_slug/2` — `nil` selects `mentions: 0` below.
  @spec own_nick_for_slug(%{String.t() => {integer(), String.t()}}, String.t()) ::
          String.t() | nil
  defp own_nick_for_slug(own_nicks, slug) do
    case Map.fetch(own_nicks, slug) do
      {:ok, {_, own_nick}} -> own_nick
      :error -> nil
    end
  end

  # Mention count over a pre-fetched capped content tail (#396 bulk path),
  # IDENTICAL fold to `count_mentions/6`'s per-window Enum.count: exclude
  # own-sent rows (fold `sender` via the ASCII nick SSOT, #121/#525), then the
  # `Mentions.mentioned?/3` SSOT predicate. `nil` own_nick → nothing to
  # match, so no mentions.
  @spec count_tail_mentions([%{sender: String.t(), body: String.t() | nil}], String.t() | nil, [
          String.t()
        ]) :: non_neg_integer()
  defp count_tail_mentions(_, nil, _), do: 0

  defp count_tail_mentions(tail, own_nick, patterns) do
    own = Identifier.canonical_target(own_nick)

    Enum.count(tail, fn %{sender: sender, body: body} ->
      Identifier.canonical_target(sender) != own and Mentions.mentioned?(body, own_nick, patterns)
    end)
  end

  # Counts unread content rows that mention the subject, excluding own-sent
  # rows (fold via the ASCII nick SSOT, #121/#525). Bounded by the scan cap.
  @spec count_mentions(
          Subject.t(),
          integer(),
          String.t(),
          integer(),
          String.t() | nil,
          [String.t()]
        ) :: non_neg_integer()
  # No configured nick on this network — nothing to match, so no mentions.
  defp count_mentions(_, _, _, _, nil, _), do: 0

  defp count_mentions(subject, network_id, channel, after_id, own_nick, patterns) do
    own = Identifier.canonical_target(own_nick)

    subject
    |> Scrollback.unread_content_tail(network_id, channel, after_id, own_nick, @mention_scan_cap)
    |> Enum.count(fn %{sender: sender, body: body} ->
      Identifier.canonical_target(sender) != own and Mentions.mentioned?(body, own_nick, patterns)
    end)
  end

  # Severity ladder — mention > message > event > none.
  @spec severity(non_neg_integer(), non_neg_integer(), non_neg_integer()) :: severity()
  defp severity(_, mentions, _) when mentions > 0, do: :mention
  defp severity(messages, _, _) when messages > 0, do: :message
  defp severity(_, _, events) when events > 0, do: :event
  defp severity(_, _, _), do: :none
end
