defmodule Grappa.WindowCounts do
  @moduledoc """
  Server-authoritative per-window unread/mention/severity snapshot (#267).

  ## Derive, don't duplicate

  `snapshot/6` computes `%{messages, mentions, events, severity}` for a
  `(subject, network, channel)` window PURELY from the read cursor
  (`Grappa.ReadCursor`) + the `messages` table. There is NO persisted
  counter and NO per-channel state in `Session.Server` — the count is
  a function of `(cursor, rows)`, so it is always correct, reconstructs
  identically on reconnect, and stays consistent across a subject's
  tabs/devices (CLAUDE.md design-discipline rule 1). cic renders the
  snapshot; it never computes counts from the raw event stream.

  ## The three counts

    * `messages` — unread CONTENT rows (`:privmsg | :notice | :action`),
      the same set `Scrollback.count_after_split/5` buckets as
      `:messages`. Unbounded (exact) — a channel with 10k unread must
      surface 10k, matching `count_after/5`.
    * `events` — unread PRESENCE/CONTROL rows (`:join | :part | :quit |
      :nick_change | :mode | :topic | :kick | :server_event`). #265: this
      is a SEPARATE low tier — presence churn never inflates the message
      or mention count.
    * `mentions` — the subset of unread content rows that mention the
      subject, via the SSOT predicate `Grappa.Mentions.mentioned?/3`
      (own_nick ∪ highlight patterns, word-boundary, case-insensitive).
      Own-sent rows are excluded (you cannot mention yourself), folding
      `sender` through the rfc1459 nick SSOT (#121). Bounded by
      `@mention_scan_cap` — the same bounded-tail strategy
      `Grappa.Push.BadgeCount` uses (SQLite has no `REGEXP`, so the
      match runs in-memory over a capped content tail).

  ## Severity ladder

  `mention > message > event > none`. A window with any mention is
  `:mention`; else with any message `:message`; else with any presence
  event `:event`; else `:none`. The aggregate/overflow badge derives its
  colour from the max severity across hidden windows (client projection).

  ## Reuse, off-Session own_nick

  `snapshot/6` takes `own_nick` + `patterns` as explicit args — it does
  NOT reach into `Session.Server`. Callers resolve them the same way the
  existing count doors do: the CONFIGURED credential nick (off-Session,
  `Push.BadgeCount.configured_nick_windows/1`) for `/me`, the live
  `state.nick` for the per-message push, and
  `UserSettings.get_highlight_patterns/1` for patterns. Accepted
  staleness after a `/nick` mirrors `BadgeCount` (see DESIGN_NOTES
  2026-06-21).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Mentions, Grappa.Scrollback, Grappa.Subject],
    exports: [PushSource, Wire]

  alias Grappa.IRC.Identifier
  alias Grappa.{Mentions, Scrollback, Subject}

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
  `mentions` is bounded by the scan cap.
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

  `own_nick` and `patterns` are REQUIRED positionals — no defaulting
  wrapper (same rule as `Scrollback.count_after/5`): a default silently
  re-opens the CP14-B3 own-nick DM over-count and the mention-fold
  hazard. `own_nick` MAY be `nil` for the unbound-but-retained network
  case (`/me` seed for a network the subject holds no credential on) —
  there is then no nick to match, so `mentions` is `0` and messages/events
  fall back to `count_after_split/5`'s channel-shape narrowing. Live
  doors (`join_reply`, per-message push) always pass a real nick.
  """
  @spec snapshot(
          Subject.t(),
          integer(),
          String.t(),
          integer() | nil,
          String.t() | nil,
          [String.t()]
        ) :: t()
  def snapshot(subject, network_id, channel, cursor, own_nick, patterns)
      when is_integer(network_id) and (is_integer(cursor) or is_nil(cursor)) and
             (is_binary(own_nick) or is_nil(own_nick)) and is_list(patterns) do
    after_id = cursor || 0

    %{messages: messages, events: events} =
      Scrollback.count_after_split(subject, network_id, channel, after_id, own_nick)

    mentions = count_mentions(subject, network_id, channel, after_id, own_nick, patterns)

    %{
      messages: messages,
      mentions: mentions,
      events: events,
      severity: severity(messages, mentions, events)
    }
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # Counts unread content rows that mention the subject, excluding own-sent
  # rows (fold via the rfc1459 nick SSOT, #121). Bounded by the scan cap.
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
    own = Identifier.canonical_nick(own_nick)

    subject
    |> Scrollback.unread_content_tail(network_id, channel, after_id, own_nick, @mention_scan_cap)
    |> Enum.count(fn %{sender: sender, body: body} ->
      Identifier.canonical_nick(sender) != own and Mentions.mentioned?(body, own_nick, patterns)
    end)
  end

  # Severity ladder — mention > message > event > none.
  @spec severity(non_neg_integer(), non_neg_integer(), non_neg_integer()) :: severity()
  defp severity(_, mentions, _) when mentions > 0, do: :mention
  defp severity(messages, _, _) when messages > 0, do: :message
  defp severity(_, _, events) when events > 0, do: :event
  defp severity(_, _, _), do: :none
end
