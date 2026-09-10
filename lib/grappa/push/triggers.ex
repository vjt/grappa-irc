defmodule Grappa.Push.Triggers do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — trigger evaluation +
  fan-out from the inbound PRIVMSG hot path. Subject-aware as of
  visitor-parity V3 (2026-05-15).

  ## Where this fits

  `Grappa.Session.Persistor` calls `evaluate_and_dispatch/2` immediately
  after a successful `Scrollback.persist_event/1` for a `:privmsg` or
  `:action` row — it owns the post-persist obligations (#369 A3), which is
  why the call moved off `Session.Server`'s `apply_effects/2` `:persist`
  arm. `dispatch_presence/4` is the one Push entry point `Session.Server`
  still calls directly: a presence transition persists no row, so there is
  nothing for `Persistor` to be the guardian of.

  Both calls are fire-and-forget — Triggers hands the work to
  `Grappa.TaskSupervisor` so the hot path stays sub-millisecond and Sender
  failures don't bleed into the mailbox. Detached but supervised: the
  worker is visible and its crash is a report, not a disappearance.

  ## Decision logic — `should_notify?/5`

  The FIRST question is "is this row mine?", decided by IDENTITY
  (`Identifier.canonical_target(sender) == canonical_target(own_nick)`), NOT
  by window shape:

    0. **Own row** (`sender` folds to `own_nick`) — never notify (#532 C).
       An OUTBOUND DM is persisted with `channel = peer` (only INBOUND
       carries `channel = own_nick`), so a shape test would misroute it to
       the channel branch and run the user's own highlight patterns over
       their own message body. Excluding by sender-identity kills that for
       both self-authored shapes (outbound DM + own channel message).

    0b. **Muted conversation** (#866, network-keyed by #1038) — the composite
       `Identifier.channel_key(network_slug, target)`, where `target` is the
       channel for a channel row and the PEER for a DM, is a key of
       `prefs.muted_targets` — never notify. This beats every reason below,
       INCLUDING a direct mention: vjt's Q2 ruling is that the mute always
       wins, because "I silenced this room" staying silent is the polite
       default. The target is the conversation and NOT `message.channel` for
       the same reason step 0 exists — an inbound DM carries
       `channel = own_nick`, so that key would collapse every DM onto a
       single mute. The NETWORK is in the key because `#linux` on two
       networks is two rooms and the same nick on two networks is two people
       (#1038, reversing #866's deliberate network-blind key).

       `until` is not read here. Expiry happens on READ, in
       `UserSettings.get_notification_prefs/1`, so this predicate stays pure
       and needs no clock.

  Otherwise returns `true` for one of three reasons:

    1. **DM** (`message.channel == own_nick`):
       `prefs.private_messages_all` OR
       `Identifier.canonical_target(message.sender) in prefs.private_messages_only`.

    2. **Channel message** (everything else): any of
       `prefs.channel_messages_all` OR
       `Identifier.canonical_target(message.channel) in prefs.channel_messages_only` OR
       (`prefs.channel_mentions` AND
       `Mentions.mentioned?(body, own_nick, highlight_patterns)`).

    3. Otherwise — no notify.

  Only the kinds in `Grappa.Scrollback.Message.notify_kinds/0` —
  `:privmsg` and `:action` (CTCP /me) — trigger. `:action` is
  semantically a `PRIVMSG` with content saying "<sender> did X" and
  carries the same notification meaning. `:notice` is intentionally
  excluded — services chatter (NickServ, ChanServ, BotNet status) is
  the dominant inbound NOTICE shape; pushing those would be spam.
  All other kinds (`:join`, `:part`, `:quit`, `:nick_change`,
  `:mode`, `:topic`, `:kick`, `:server_event`) are presence /
  control plane and do not push.

  ## The second trigger class — `/notify` presence (#378)

  Scrollback KINDS still never push, as above. What does push is a
  `/notify` presence TRANSITION, via `dispatch_presence/4` — a different
  event on a different path (`Session.Server`'s `presence_changed` effect
  arm, no `%Message{}` involved), gated by its own two prefs
  `presence_online` / `presence_offline`, both default OFF. Baselines
  (`:initial`) never push, whatever the prefs: adding a watch list or
  reconnecting must not fire a notification storm.

  The two classes are deliberately orthogonal — the watch list curates
  WHO, the prefs gate push-vs-toast-only globally, and neither pref is a
  member of `UserSettings`' at-least-one-trigger set (see there for why).

  #395 — the kind gate reads `Message.notify_kinds/0` (a subset of
  `Message.content_kinds/0`, derived from ONE projection declaration) via
  the `@notify_kinds` compile-time attribute, NOT a local `[:privmsg,
  :action]` literal. That literal used to be a second, independently
  maintained kind list: the unread-window count derived from
  `content_kinds/0` (which includes `:notice`), while this path hard-coded
  its own copy. The two happened to agree — badge-worthy ⊆ unread — but
  by accident, not by construction. Reading the shared SSOT makes that
  subset structural: the notify set can never drift from, or exceed, the
  unread-content set.

  ## own_nick — per-network, NOT account name

  The caller (Session.Server) holds the per-(subject, network) IRC nick
  in `state.nick`, reconciled at 001 RPL_WELCOME and updated on
  self-NICK rename. Triggers takes it as an explicit argument
  rather than re-deriving from the subject's display name, dodging
  the CP15 H3 account-name-vs-IRC-nick hazard cic-side.

  ## Withholding is an event, not an absence (issue 2067)

  Both dispatch paths end in the same `#182` foreground gate, and until
  issue 2067 that gate skipped the fan-out in silence. A WITHHELD push
  and a push that never triggered therefore looked identical from
  outside — an operator with no notification on their phone and an empty
  `journalctl … | grep push` had no way to tell "your own client was in
  the foreground" from "the trigger never fired", which is precisely the
  pair a live debugging session has to separate first.

  So the suppressing answer reports, on both doors and through ONE
  reporter (`report_suppressed/2`):

    * `[:grappa, :push, :suppressed]` — measurements `%{count: 1}`,
      metadata `%{subject: Grappa.Subject.t(), network_slug:
      String.t(), reason: t:suppression_reason/0}`. Emitted from the
      message path and the presence path alike; ONE event, because two
      spellings of the same withholding would have to be added together
      before they answered anything.
    * a `Logger.info` `push.trigger suppressed` line carrying `reason:`,
      `network:` and the subject, which is the half that a 2am grep
      actually reads.

  The DELIVERING answer stays quiet here: `Push.Sender` already emits
  `[:grappa, :push, :send, :start | :stop]` around the fan-out, and a
  second event for the same delivery would be a number to reconcile
  rather than a fact to read.

  ### What the counter measures, exactly

  Withheld TRIGGER dispatches, at this layer — not undelivered pushes.
  The gate runs before the fan-out and deliberately pays no subscription
  query, so a subject with the PWA open and NO registered device is
  counted here even though `Sender.send_to_subject/2` would have hit its
  empty-list arm and sent nothing either way. That is a boundary, not an
  oversight: this module decides whether to dispatch, `Push.Sender` owns
  what a dispatch reaches, and buying the distinction would mean a
  `push_subscriptions` read on every suppression to answer a question
  the device-list UI already answers directly.

  ### Volume

  Bounded by the PREFS, and the bound is not the same for everyone. Under
  the defaults (`channel_messages_all: false`, `channel_mentions: true`,
  `private_messages_all: true`) a suppression needs a DM or a mention, so
  the line is rare. An operator who turns `channel_messages_all` ON has
  asked to be notified for every channel message, and while their PWA is
  on-screen that is one `:info` line and one event PER received channel
  message per joined channel. `LOG_LEVEL` is the knob if that is not
  wanted; the pref is what sets the rate, and it is worth knowing which
  one you have set before reading the volume.

  The gate is the SECOND conjunct of the `and` at both call sites and
  must stay there. Short-circuiting means a message the prefs never
  matched never reaches the gate and so can never be counted as
  suppressed — that ordering IS the distinction this section exists to
  make, and reversing it would make the new event repeat the old lie in
  a louder voice.

  ## No silent drops

  `evaluate_and_dispatch/2` always returns `:ok`. Any failure inside
  the spawned Task surfaces as a SASL crash log + `:telemetry`
  events from `Push.Sender`. NO `try/rescue` swallowing per
  `feedback_no_silent_drops_*`.
  """

  alias Grappa.IRC.Identifier
  alias Grappa.{Mentions, Push, Subject, UserSettings, WSPresence}
  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  require Logger

  # #395 — the notify-worthy kind gate. Reads the shared SSOT subset
  # (`Message.notify_kinds/0` ⊆ `Message.content_kinds/0`) instead of a
  # local `[:privmsg, :action]` literal, so badge/push kinds can never
  # drift from — or exceed — the unread-content set. A module attribute
  # (inlined at compile time) so it is usable in the `when kind in
  # @notify_kinds` guards below (a function call is not allowed in a guard).
  @notify_kinds Message.notify_kinds()

  @typedoc """
  Caller context for `evaluate_and_dispatch/2`. Session.Server
  assembles this map from `state` at the call site so Triggers
  doesn't reach back into the GenServer state shape.

  `subject_label` is the WSPresence presence key (`user.name` for
  users, `"visitor:" <> visitor.id` for visitors — identical to
  `Session.Server.state.subject_label`); the foreground-suppression
  gate reads `WSPresence.any_visible?/1` with it (#182).
  """
  @type ctx :: %{
          required(:subject) => Subject.t(),
          required(:subject_label) => String.t(),
          required(:network_slug) => String.t(),
          required(:own_nick) => String.t()
        }

  @typedoc """
  `t:Grappa.UserSettings.notification_prefs/0` is a `map()` typed
  alias; re-exported here for clarity at the call site.
  """
  @type prefs :: UserSettings.notification_prefs()

  @typedoc """
  Classification of one `/notify` presence report — the closed pair
  `t:Grappa.Session.Presence.change_kind/0` carries.

  DUPLICATED rather than referenced on purpose: `Presence` is not a
  `Grappa.Session` export, and `Grappa.Push` cannot dep `Grappa.Session`
  anyway because `Grappa.Session` already deps `Grappa.Push` — that is a
  Boundary cycle. Two atoms are cheaper than either alternative.
  """
  @type presence_kind :: :initial | :transition

  @typedoc """
  Why a TRIGGERED push was withheld (issue 2067). A closed set with one
  member today — `:foreground_visible`, the `#182` gate seeing at least
  one of the subject's devices report the PWA on-screen.

  An atom and not a free string because it is published: it rides the
  `[:grappa, :push, :suppressed]` telemetry metadata and the `reason:`
  Logger key, so a second withholding reason must be added HERE and be
  legible to an aggregator, not invented at a call site.
  """
  @type suppression_reason :: :foreground_visible

  # ---------------------------------------------------------------------------
  # Public — call from Session.Server
  # ---------------------------------------------------------------------------

  @doc """
  Evaluates trigger logic for `message` against the subject's
  notification preferences and, on a match, fires the Web Push
  fan-out via `Push.Sender.send_to_subject/2`.

  Fire-and-forget — starts a supervised task and returns `:ok`
  immediately. Per-message work (prefs lookup, mention regex,
  Sender fan-out) happens out-of-band so the Session.Server hot
  path never blocks on it.

  Only `Message.notify_kinds/0` (`:privmsg`, `:action`) proceed past the
  kind gate; every other kind short-circuits to `:ok` without spawning the
  Task — avoids polluting the BEAM scheduler with no-op spawns
  on the high-volume presence-event paths.
  """
  @spec evaluate_and_dispatch(Message.t(), ctx()) :: :ok
  def evaluate_and_dispatch(%Message{kind: kind} = message, ctx)
      when kind in @notify_kinds and is_map(ctx) do
    %{
      subject: subject,
      subject_label: subject_label,
      network_slug: network_slug,
      own_nick: own_nick
    } = ctx

    # Discarded, not matched: a supervisor can refuse to start a child,
    # and a strict match would turn a skipped notification into a crash
    # on the session hot path the day a ceiling is configured.
    _ =
      Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
        prefs = UserSettings.get_notification_prefs(subject)
        patterns = UserSettings.get_highlight_patterns(subject)

        # #182 — foreground-suppression gate. `should_notify?/5` stays a
        # PURE predicate (no IO); the visibility check reads WSPresence
        # GenServer state, so it is a SEPARATE explicit step here. If ANY
        # of the subject's devices reports the PWA is on-screen, skip the
        # ENTIRE fan-out to ALL of that subject's subscriptions. This is
        # PER-USER (cross-device) suppression, NOT the old SW gate's
        # per-device parity — the server has no push-endpoint→socket-pid
        # mapping, so it can't suppress selectively. Moved server-side
        # because the SW's `clients.matchAll` is unreliable on iOS
        # (root cause of #182). Read RAW (no debounce) so a mention landing
        # right after you background still delivers. Deliver-leaning: an
        # unreported/backgrounded device reads `:hidden`, so this never
        # suppresses to a device that hasn't claimed the foreground.
        #
        # issue 2067 — the gate now REPORTS when it withholds. It stays the
        # second conjunct so a message the prefs never matched short-circuits
        # away before reaching it and cannot be miscounted as suppressed.
        if should_notify?(message, network_slug, own_nick, prefs, patterns) and
             not foreground_visible?(subject, subject_label, network_slug) do
          payload = build_payload(message, network_slug, own_nick, subject)
          Push.Sender.send_to_subject(subject, payload)
        end
      end)

    :ok
  end

  def evaluate_and_dispatch(%Message{}, _), do: :ok

  @doc """
  Dispatches the Web Push for one `/notify` presence report (#378).

  Same fire-and-forget shape as `evaluate_and_dispatch/2`: supervised
  task, always `:ok`, no `try/rescue` (the no-silent-drops contract above).

  A baseline (`:initial`) short-circuits in the FUNCTION HEAD, before the
  Task spawn — that is the whole point of splitting the clause rather than
  branching inside: a MONITOR/WATCH baseline burst on connect, a bulk
  `/notify add`, and every reconnect re-arm are the high-volume shapes, and
  they must spawn ZERO Tasks, not N no-op ones.

  There is deliberately NO catch-all clause. `change_kind()` is a closed
  pair, so a third kind must crash `Session.Server` rather than be dropped
  in silence.
  """
  @spec dispatch_presence(String.t(), :online | :offline, presence_kind(), ctx()) :: :ok
  def dispatch_presence(nick, presence, :transition, ctx)
      when is_binary(nick) and presence in [:online, :offline] and is_map(ctx) do
    %{subject: subject, subject_label: subject_label, network_slug: network_slug} = ctx

    # Discarded, not matched: a supervisor can refuse to start a child,
    # and a strict match would turn a skipped notification into a crash
    # on the session hot path the day a ceiling is configured.
    _ =
      Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
        prefs = UserSettings.get_notification_prefs(subject)

        # #182 — the same foreground-suppression gate as the message path,
        # and for the same reason it is a SEPARATE step: the pure predicate
        # stays free of IO. If ANY device has the PWA on-screen, the in-app
        # presence toast IS the notification and the push is skipped — and
        # since issue 2067 it says so, through the SAME reporter as the
        # message path rather than a second event of its own.
        if should_notify_presence?(presence, prefs) and
             not foreground_visible?(subject, subject_label, network_slug) do
          Push.Sender.send_to_subject(subject, Payload.build_presence(nick, presence, network_slug))
        end
      end)

    :ok
  end

  def dispatch_presence(_, _, :initial, _), do: :ok

  # ---------------------------------------------------------------------------
  # Public — pure predicate (testable in isolation)
  # ---------------------------------------------------------------------------

  @doc """
  Returns `true` when `message`, received on `network_slug`, should produce a
  push notification for an operator whose IRC nick is `own_nick`, given
  `prefs`.

  `network_slug` is read by exactly ONE branch — the mute (#1038), whose key
  is the composite `(network, conversation)` `ChannelKey`. Every other branch
  is network-independent. It is a required positional argument rather than an
  optional one because a caller that forgets it must not silently fall back
  to the network-blind behaviour this issue removed.

  `highlight_patterns` is the per-user watchlist (from
  `UserSettings.get_highlight_patterns/1`); used only when the
  channel-mentions branch fires.

  Pure function — no DB, no IO. The full decision tree lives in
  the moduledoc; the body is a literal transcription.
  """
  @spec should_notify?(
          Message.t(),
          network_slug :: String.t(),
          own_nick :: String.t(),
          prefs(),
          highlight_patterns :: [String.t()]
        ) :: boolean()
  def should_notify?(%Message{kind: kind}, _, _, _, _)
      when kind not in @notify_kinds,
      do: false

  def should_notify?(%Message{} = message, network_slug, own_nick, prefs, patterns)
      when is_binary(network_slug) and is_binary(own_nick) and is_map(prefs) and is_list(patterns) do
    cond do
      # #532 C — the subject's OWN rows never notify, decided by IDENTITY
      # (sender folds to own_nick), NOT by window shape. An OUTBOUND DM is
      # persisted with `channel = peer` (only INBOUND carries `channel =
      # own_nick`), so the `dm?/2` shape test below misses it and it would
      # fall to the channel branch, where the user's OWN highlight patterns
      # run over their OWN message body — counting an outgoing DM as
      # notify-worthy. Excluding by sender-identity kills that for BOTH
      # directions of self-authored rows (outbound DM + own channel msg).
      # This is the ONE predicate `Push.BadgeCount` folds over the unread
      # tail, so the badge and the OS notification can never disagree.
      own_row?(message, own_nick) -> false
      # #866 — the per-conversation mute, and it OUTRANKS every reason below,
      # a direct mention included (vjt's Q2: the mute always wins). Placing it
      # in the `cond` rather than inside the two branches is what makes that
      # true structurally instead of by remembering to add `and not muted?` to
      # each new disjunct.
      muted?(message, network_slug, prefs, own_nick) -> false
      dm?(message, own_nick) -> dm_match?(message, prefs)
      true -> channel_match?(message, prefs, own_nick, patterns)
    end
  end

  @doc """
  Returns `true` when a presence transition in `presence` should push,
  given `prefs`. Pure — the twin of `should_notify?/5` for the second
  trigger class.

  `Map.fetch!/2`, not `Map.get/3` with a default: `merge_with_defaults/1`
  guarantees both keys are present in every prefs map a reader can get,
  so a fallback would be a second place stating the default — and it
  would state it silently if that guarantee ever broke.
  """
  @spec should_notify_presence?(:online | :offline, prefs()) :: boolean()
  def should_notify_presence?(:online, prefs) when is_map(prefs),
    do: Map.fetch!(prefs, :presence_online)

  def should_notify_presence?(:offline, prefs) when is_map(prefs),
    do: Map.fetch!(prefs, :presence_offline)

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # The #182 gate, plus the report issue 2067 was filed for. Reads exactly
  # what it used to (`WSPresence.any_visible?/1`, RAW, no debounce) and
  # returns the same boolean; the only new thing is that the SUPPRESSING
  # answer is no longer silent.
  #
  # Only that answer speaks. A `false` means the fan-out proceeds, and from
  # there `Push.Sender`'s own start/stop telemetry is the record — reporting
  # here as well would count every delivery twice, once as a near-miss.
  #
  # Both call sites reach this through the same `not …` they always had, so
  # the reading at the `if` is unchanged and the gate keeps its position as
  # the second conjunct (see the moduledoc: that ordering is what separates
  # "withheld" from "never triggered").
  @spec foreground_visible?(Subject.t(), String.t(), String.t()) :: boolean()
  defp foreground_visible?(subject, subject_label, network_slug) do
    if WSPresence.any_visible?(subject_label) do
      report_suppressed(subject, network_slug, :foreground_visible)
      true
    else
      false
    end
  end

  # Both doors on one withholding: the counter an exporter aggregates, and
  # the line an operator greps. ONE function so the message path and the
  # presence path can never drift into two spellings of the same event.
  #
  # Logger FIRST, counter second, and that order is load-bearing rather than
  # stylistic: anything that observes the counter — the test that pins this
  # line included — is then guaranteed the message is already on its way to
  # the handlers, so the two halves of a single withholding can be
  # correlated without a sleep.
  #
  # `:reason`, `:network`, `:subject_kind`, `:user_id` and `:visitor_id` are
  # ALREADY in the `config/config.exs` Logger `:metadata` allowlist. That is
  # why this slice touches no config file: an undeclared key is dropped at
  # FORMAT time, so a new one would compile, fire, and still print bare —
  # and editing `config/*.exs` would additionally turn a hot deploy cold.
  #
  # `:network` and not `:channel`, even though the message path knows the
  # channel and the key is allowlisted too: this reporter serves BOTH doors
  # and the presence one has no channel, so taking it would either split the
  # reporter in two or make it print an empty field half the time. The
  # network is the one context both doors carry, and on a multi-network
  # bouncer it is what turns "something was withheld" into "something was
  # withheld on azzurra".
  @spec report_suppressed(Subject.t(), String.t(), suppression_reason()) :: :ok
  defp report_suppressed(subject, network_slug, reason) do
    Logger.info(
      "push.trigger suppressed",
      [reason: reason, network: network_slug] ++ subject_metadata(subject)
    )

    :telemetry.execute(
      [:grappa, :push, :suppressed],
      %{count: 1},
      %{subject: subject, network_slug: network_slug, reason: reason}
    )
  end

  # There is deliberately NO catch-all: `Grappa.Subject.t/0` is a closed
  # pair, so a third shape must crash the detached Task (a supervisor
  # report) rather than print a suppression the operator cannot attribute
  # to anyone. Same posture `dispatch_presence/4` takes on `change_kind()`.
  @spec subject_metadata(Subject.t()) :: keyword()
  defp subject_metadata({:user, id}) when is_binary(id), do: [subject_kind: :user, user_id: id]

  defp subject_metadata({:visitor, id}) when is_binary(id),
    do: [subject_kind: :visitor, visitor_id: id]

  # Door #1: build the push payload, stamping the current badge count when
  # the `BadgeSource` seam is configured. The triggering message is already
  # persisted (this runs inside the post-`persist_event` Task), so the
  # count includes it. `nil` — the transient hot-deploy window before the
  # `:badge_source` config is live — OMITS the badge field rather than
  # crashing the Task or stamping a wrong `0` that would clear the icon;
  # the push still fires, the SW just leaves the badge untouched.
  @spec build_payload(Message.t(), String.t(), String.t(), Subject.t()) :: Payload.t()
  defp build_payload(message, network_slug, own_nick, subject) do
    payload = Payload.build(message, network_slug, own_nick)

    case Push.BadgeSource.count(subject) do
      count when is_integer(count) -> Payload.put_badge(payload, count)
      nil -> payload
    end
  end

  # #532 C — is this row the subject's OWN message? Folded identity
  # compare (`Identifier.canonical_target/1`, #121) between the row's sender
  # and the live own_nick, NOT the window-shape `channel == own_nick` test
  # (which only holds for INBOUND DMs, so it can't recognise an outbound
  # DM as self-authored). The row already carries everything needed to
  # decide — this is the "is this row mine?" the moduledoc's decision tree
  # asks first.
  defp own_row?(%Message{sender: sender}, own_nick) when is_binary(sender) do
    Identifier.canonical_target(sender) == Identifier.canonical_target(own_nick)
  end

  defp own_row?(_, _), do: false

  # Canonical DM rule across the codebase: inbound row's `channel`
  # field equals own_nick. Mirrors `Grappa.Scrollback.dm_peer/4`'s
  # inbound branch + cic's dm-listener channelKey rule. #537 — the
  # `channel` KEY is now folded at the persist boundary
  # (`Message.canonicalize_channel/1`), so this compare MUST fold both
  # sides (`canonical_target/1`) or a mixed-case own_nick fails to match
  # its own folded DM rows.
  defp dm?(%Message{channel: channel}, own_nick) when is_binary(channel) and is_binary(own_nick),
    do: Identifier.canonical_target(channel) == Identifier.canonical_target(own_nick)

  defp dm?(_, _), do: false

  # #866 — is this row's CONVERSATION muted? Network-keyed since #1038.
  #
  # The TARGET is the conversation, NOT the row's `channel` field. An inbound
  # DM is persisted with `channel = own_nick`, so keying on `channel` would
  # make one "mute vjt" entry silence every DM the operator ever receives,
  # while "mute alice" silenced nothing. So: the channel for a channel row,
  # the PEER for a DM.
  #
  # #1038 — the target alone is not the key. `Identifier.channel_key/2`
  # composes it with the network the row arrived on, because the same channel
  # name (and the same nick) on two networks is two conversations. That
  # builder applies the same `canonical_target/1` fold `UserSettings` applies
  # at write, so the string compared here is byte-identical to the one stored.
  #
  # A stored BARE key can never match: it has no separator, so no composite
  # this function builds can equal it. That is the intended failure direction
  # — a mute the migration missed goes LOUD, it does not silence every
  # network the way the pre-#1038 key did.
  #
  # `until` is deliberately not consulted. Expiry belongs to the READER
  # (`UserSettings.get_notification_prefs/1`, Q3), which is what keeps this
  # predicate pure and the shared truth-table free of a `now` column.
  defp muted?(%Message{channel: channel, sender: sender} = message, network_slug, prefs, own_nick)
       when is_binary(channel) and is_binary(sender) and is_binary(network_slug) do
    target = if dm?(message, own_nick), do: sender, else: channel

    Map.has_key?(
      Map.get(prefs, :muted_targets, %{}),
      Identifier.channel_key(network_slug, target)
    )
  end

  defp muted?(_, _, _, _), do: false

  defp dm_match?(%Message{} = message, prefs) do
    Map.get(prefs, :private_messages_all, false) or
      sender_in_whitelist?(message, prefs)
  end

  defp sender_in_whitelist?(%Message{sender: sender}, prefs) when is_binary(sender) do
    # Fold the sender through the ASCII nick SSOT (#121/#525) — never a bare
    # String.downcase, which Unicode-over-folds non-ASCII and diverges from
    # the ASCII fold. Brackets `[ ] \ ~` are NOT folded, so foo[bar] and
    # foo{bar} are DELIBERATELY distinct (CASEMAPPING=ascii). The stored
    # list is canonicalized to the same fold by UserSettings.normalize_list.
    Identifier.canonical_target(sender) in Map.get(prefs, :private_messages_only, [])
  end

  defp sender_in_whitelist?(_, _), do: false

  defp channel_match?(%Message{} = message, prefs, own_nick, patterns) do
    Map.get(prefs, :channel_messages_all, false) or
      channel_in_whitelist?(message, prefs) or
      mention_match?(message, prefs, own_nick, patterns)
  end

  defp channel_in_whitelist?(%Message{channel: channel}, prefs) when is_binary(channel) do
    # #537 — fold via `canonical_target/1` (the fold at every identifier
    # boundary) to match the store path (`UserSettings.normalize_list`).
    # An exact-string membership test on a sigil-gated fold silently
    # stopped applying to a nick-shaped window after a case-different
    # re-open; folding every identifier closes that hole.
    Identifier.canonical_target(channel) in Map.get(prefs, :channel_messages_only, [])
  end

  defp channel_in_whitelist?(_, _), do: false

  defp mention_match?(%Message{body: body, sender: sender}, prefs, own_nick, patterns) do
    # #1674 — the sender half of the mention rule, the same conjunct the
    # badge folds (`WindowCounts.mention_row?/3`). The kind gate already
    # drops every `:notice`, so this closes the arrival it does NOT cover:
    # a services PRIVMSG (MemoServ delivery) naming the operator, routed to
    # `$server` and landing in the channel branch below the DM shape test.
    # Badge and OS notification must never disagree about what a mention is.
    Map.get(prefs, :channel_mentions, false) and
      Mentions.mentionable_sender?(sender) and
      Mentions.mentioned?(body, own_nick, patterns)
  end
end
