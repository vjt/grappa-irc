defmodule Grappa.Push.Triggers do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — trigger evaluation +
  fan-out from the inbound PRIVMSG hot path. Subject-aware as of
  visitor-parity V3 (2026-05-15).

  ## Where this fits

  `Grappa.Session.Server`'s `apply_effects/2` `:persist` arm calls
  `evaluate_and_dispatch/2` immediately after a successful
  `Scrollback.persist_event/1` for a `:privmsg` or `:action` row. The
  call is fire-and-forget — Triggers spawns an unlinked `Task` so the
  hot path stays sub-millisecond and Sender failures don't bleed into
  the mailbox.

  ## Decision logic — `should_notify?/4`

  Returns `true` for one of three reasons:

    1. **DM** (`message.channel == own_nick`):
       `prefs.private_messages_all` OR
       `String.downcase(message.sender) in prefs.private_messages_only`.

    2. **Channel message** (everything else): any of
       `prefs.channel_messages_all` OR
       `String.downcase(message.channel) in prefs.channel_messages_only` OR
       (`prefs.channel_mentions` AND
       `Mentions.mentioned?(body, own_nick, highlight_patterns)`).

    3. Otherwise — no notify.

  Only `:privmsg` and `:action` (CTCP /me) trigger. `:action` is
  semantically a `PRIVMSG` with content saying "<sender> did X" and
  carries the same notification meaning. `:notice` is intentionally
  excluded — services chatter (NickServ, ChanServ, BotNet status) is
  the dominant inbound NOTICE shape; pushing those would be spam.
  All other kinds (`:join`, `:part`, `:quit`, `:nick_change`,
  `:mode`, `:topic`, `:kick`, `:server_event`) are presence /
  control plane and do not push.

  ## own_nick — per-network, NOT account name

  The caller (Session.Server) holds the per-(subject, network) IRC nick
  in `state.nick`, reconciled at 001 RPL_WELCOME and updated on
  self-NICK rename. Triggers takes it as an explicit argument
  rather than re-deriving from the subject's display name, dodging
  the CP15 H3 account-name-vs-IRC-nick hazard cic-side.

  ## No silent drops

  `evaluate_and_dispatch/2` always returns `:ok`. Any failure inside
  the spawned Task surfaces as a SASL crash log + `:telemetry`
  events from `Push.Sender`. NO `try/rescue` swallowing per
  `feedback_no_silent_drops_*`.
  """

  alias Grappa.{Mentions, Push, Subject, UserSettings}
  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  @typedoc """
  Caller context for `evaluate_and_dispatch/2`. Session.Server
  assembles this map from `state` at the call site so Triggers
  doesn't reach back into the GenServer state shape.
  """
  @type ctx :: %{
          required(:subject) => Subject.t(),
          required(:network_slug) => String.t(),
          required(:own_nick) => String.t()
        }

  @typedoc """
  `t:Grappa.UserSettings.notification_prefs/0` is a `map()` typed
  alias; re-exported here for clarity at the call site.
  """
  @type prefs :: UserSettings.notification_prefs()

  # ---------------------------------------------------------------------------
  # Public — call from Session.Server
  # ---------------------------------------------------------------------------

  @doc """
  Evaluates trigger logic for `message` against the subject's
  notification preferences and, on a match, fires the Web Push
  fan-out via `Push.Sender.send_to_subject/2`.

  Fire-and-forget — spawns an unlinked `Task` and returns `:ok`
  immediately. Per-message work (prefs lookup, mention regex,
  Sender fan-out) happens out-of-band so the Session.Server hot
  path never blocks on it.

  Only `:privmsg` and `:action` kinds proceed past the kind gate;
  every other kind short-circuits to `:ok` without spawning the
  Task — avoids polluting the BEAM scheduler with no-op spawns
  on the high-volume presence-event paths.
  """
  @spec evaluate_and_dispatch(Message.t(), ctx()) :: :ok
  def evaluate_and_dispatch(%Message{kind: kind} = message, ctx)
      when kind in [:privmsg, :action] and is_map(ctx) do
    %{subject: subject, network_slug: network_slug, own_nick: own_nick} = ctx

    {:ok, _} =
      Task.start(fn ->
        prefs = UserSettings.get_notification_prefs(subject)
        patterns = UserSettings.get_highlight_patterns(subject)

        if should_notify?(message, own_nick, prefs, patterns) do
          payload = Payload.build(message, network_slug, own_nick)
          Push.Sender.send_to_subject(subject, payload)
        end
      end)

    :ok
  end

  def evaluate_and_dispatch(%Message{}, _), do: :ok

  # ---------------------------------------------------------------------------
  # Public — pure predicate (testable in isolation)
  # ---------------------------------------------------------------------------

  @doc """
  Returns `true` when `message` should produce a push notification
  for an operator whose IRC nick is `own_nick`, given `prefs`.

  `highlight_patterns` is the per-user watchlist (from
  `UserSettings.get_highlight_patterns/1`); used only when the
  channel-mentions branch fires.

  Pure function — no DB, no IO. The full decision tree lives in
  the moduledoc; the body is a literal transcription.
  """
  @spec should_notify?(
          Message.t(),
          own_nick :: String.t(),
          prefs(),
          highlight_patterns :: [String.t()]
        ) :: boolean()
  def should_notify?(%Message{kind: kind}, _, _, _)
      when kind not in [:privmsg, :action],
      do: false

  def should_notify?(%Message{} = message, own_nick, prefs, patterns)
      when is_binary(own_nick) and is_map(prefs) and is_list(patterns) do
    if dm?(message, own_nick) do
      dm_match?(message, prefs)
    else
      channel_match?(message, prefs, own_nick, patterns)
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # Canonical DM rule across the codebase: inbound row's `channel`
  # field equals own_nick. Mirrors `Grappa.Scrollback.dm_peer/4`'s
  # inbound branch + cic's dm-listener channelKey rule.
  defp dm?(%Message{channel: channel}, own_nick), do: channel == own_nick

  defp dm_match?(%Message{} = message, prefs) do
    Map.get(prefs, :private_messages_all, false) or
      sender_in_whitelist?(message, prefs)
  end

  defp sender_in_whitelist?(%Message{sender: sender}, prefs) when is_binary(sender) do
    String.downcase(sender) in Map.get(prefs, :private_messages_only, [])
  end

  defp sender_in_whitelist?(_, _), do: false

  defp channel_match?(%Message{} = message, prefs, own_nick, patterns) do
    Map.get(prefs, :channel_messages_all, false) or
      channel_in_whitelist?(message, prefs) or
      mention_match?(message, prefs, own_nick, patterns)
  end

  defp channel_in_whitelist?(%Message{channel: channel}, prefs) when is_binary(channel) do
    String.downcase(channel) in Map.get(prefs, :channel_messages_only, [])
  end

  defp channel_in_whitelist?(_, _), do: false

  defp mention_match?(%Message{body: body}, prefs, own_nick, patterns) do
    Map.get(prefs, :channel_mentions, false) and
      Mentions.mentioned?(body, own_nick, patterns)
  end
end
