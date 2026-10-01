defmodule Grappa.Push.Payload do
  @moduledoc """
  Builds a Web Push notification payload from a persisted scrollback
  message. Push notifications cluster B4 (2026-05-14).

  ## Documented exception to the wire-shape rule

  CLAUDE.md mandates server emits typed atoms / structs / booleans and
  cic owns user-facing strings. Push payloads are the documented
  exception: the OS notification surface (lockscreen, notification
  centre, system tray) renders `title` and `body` BEFORE cic JS gets
  a chance, so cic-side localization is impossible. Server picks the
  strings; keep them simple + English.

  ## Title / body

    * **DM** (`Message.dm?/1`): `title = sender`, body = the
      message body. Notification shape mirrors how mobile messengers
      surface a 1:1 chat — sender on top line, content on second.
    * **Channel** (everything else): `title = "<sender> in <channel>"`,
      body = the message body. Reader sees both who spoke and where in
      one glance.

  ## The two rendered fields are PROJECTED; the two key fields are not (issue 1977)

  `title` and `body` go through `Grappa.IRC.MircFormat.plain_text/1` —
  the de-formatted view, "the text a reader saw". `tag` and `url` do NOT.

  The projection is not cosmetic. `\\x03` is non-printing, so the OS
  notification renderer drops the byte and leaves its decimal operands in
  the text as ordinary digits: a coloured line reached a lock screen as
  `04QUACK` for a wire `\\x03` `0` `4` `QUACK`. Every other surface already
  projects — `Grappa.Mentions` calls `plain_text/1` before matching so a
  padded body cannot dodge or forge a mention, and cic parses the same
  bytes into styled runs for the message list. Push was the one door that
  shipped them raw, and that asymmetry WAS the defect. Interpreting rather
  than stripping is not available here: the Web Notifications API takes
  plain text, there is no styled-run surface to render into.

  The projection sits on the COMPOSED title rather than on `channel`
  alone, and that is a measurement rather than caution. A nick cannot
  carry `\\x03`: `Identifier.valid_nick?/1`'s charset holds no control
  byte, and the host arm of `valid_sender?/1` excludes `\\x00-\\x1f`
  outright (its `<meta>` arm would accept one, but that shape is minted
  here, never read off the wire). A CHANNEL can —
  `Identifier.valid_channel?/1` excludes only
  whitespace, comma and BELL; `Parser.strip_unsafe_bytes/1` removes only
  `\\x00 \\r \\n`; and `canonical_target/1` folds `A-Z` and passes every
  other byte through, so a `\\x03` in a channel name survives ingress,
  persist and fold intact. One projection over the whole string covers
  both arms with one door, and costs nothing on the sender arm because it
  is provably a no-op on a valid nick.

  `tag` and `url` keep the channel KEY as stored — the key/display split.
  `tag` is the OS dedup key and `url` is a deep link cic resolves back to
  a window; projecting either would coalesce the banner against a surface
  that does not exist and land the click on a channel nobody is in.

  The stripper is the mIRC one, not a control-byte purge: CTCP framing
  (`\\x01`) round-trips verbatim per CLAUDE.md's wire-format rule, so an
  ACTION row still reaches the payload framed.

  ## Presence transitions (#378)

  `build_presence/3` is the sibling constructor for a `/notify` presence
  flip. It returns the same `t()` and needs no service-worker change, but
  it is a SEPARATE function rather than a clause of `build/2`: that one is
  hard-wired to a `%Scrollback.Message{}`, and a presence transition has no
  row, no sender and no body. It is also PURE in all three arguments — no
  `subject`, no badge count, no DB (see the badge note below).

  ## Tag — OS-level dedup key

  Format: `"<network_slug>:<channel_or_dm_peer>"`. Browsers + mobile
  OSes use `tag` to coalesce successive notifications targeting the
  same conversation surface — three messages from `alice` in `#sniffo`
  collapse into one stack instead of three separate banners. Network
  slug prefix prevents `#general` on libera from colliding with
  `#general` on freenode.

  For DMs, the dm peer is `sender` (inbound DM the recipient sees).
  For channel rows, the dm peer is the channel name itself.

  ## URL — deep-link

  Format: `/?network=<slug>&channel=<percent-encoded>`. The format is
  fixed at B4 so B5 (Playwright e2e + SW notificationclick handler)
  has nothing to negotiate when wiring up cic-side selection. cic
  itself does NOT parse `?network` / `?channel` on cold-load yet —
  B5 adds the SW notificationclick handler + the main.tsx URL-param
  reader together. Until then the URL ships in the payload but
  clicking the OS notification just opens `/`.

  The channel name is percent-encoded because IRC channel names start
  with `#`, which would otherwise be interpreted as a URL fragment by
  any URL parser cic adds in B5.

  ## Boundary

  Lives inside the `Grappa.Push` context boundary alongside
  `Push.Sender` + `Push.Subscription`. Pure function — no DB, no IO,
  trivial to test.
  """

  alias Grappa.IRC.{Identifier, MircFormat}
  alias Grappa.Scrollback.Message

  @typedoc """
  Wire shape consumed by `Grappa.Push.Sender.send_to_subscription/2`.
  Same shape as `t:Grappa.Push.Sender.payload/0` (cross-module reference
  not used directly so this module stays free of the cycle through
  `Push.Sender`'s `ExNudge` dep).
  """
  @type t :: %{
          required(:title) => String.t(),
          required(:body) => String.t(),
          required(:tag) => String.t(),
          required(:url) => String.t(),
          optional(:badge) => non_neg_integer()
        }

  @doc """
  Builds a notification payload for `message` on `network_slug`.

  DM vs channel is `Grappa.Scrollback.Message.dm?/1` — the same rule
  `Grappa.Push.Triggers.should_notify?/5` decides by (issue 1365), so the
  row that notified as a DM is the row that renders as one. It used to be
  a second copy of "the row's `channel` TAG folds to own_nick", which took
  an `own_nick` argument for nothing else; the TAG is no longer re-keyed on
  a self-rename, and a second definition of DM is how the two would drift.
  """
  @spec build(Message.t(), network_slug :: String.t()) :: t()
  def build(%Message{} = message, network_slug) when is_binary(network_slug) do
    dm? = Message.dm?(message)

    sender = message.sender

    {title, dedup_key, deep_link_target} =
      if dm? do
        {sender, sender, sender}
      else
        {"#{sender} in #{message.channel}", message.channel, message.channel}
      end

    %{
      title: MircFormat.plain_text(title),
      body: MircFormat.plain_text(message.body || ""),
      tag: "#{network_slug}:#{dedup_key}",
      url: build_url(network_slug, deep_link_target)
    }
  end

  @doc """
  Builds a notification payload for a `/notify` presence transition (#378).

  Pure function of its three arguments — deliberately no `subject` and no
  badge stamp: `Push.BadgeSource.count/1` counts unread MESSAGES, and a
  presence flip creates none, so stamping the current count would attach a
  stale, causally-unrelated number and cost a DB read per transition. An
  absent `badge` leaves the home-screen icon untouched, which is exactly
  right here.

  ## Copy

  `"<nick> is online"` / `"<nick> went offline"`, body `"on <slug>"`. The
  verbs are the ones cic's in-app toast already renders for the SAME event
  (`Toasts.tsx`) — one event, one spelling. The network rides in the body
  because a watch list spanning two networks otherwise produces two
  identical-looking banners.

  ## Tag

  `"<network_slug>:presence:<folded_nick>"`. The `presence:` infix is
  load-bearing, not decoration: `build/2` writes
  `"<slug>:<channel_or_dm_peer>"`, so a BARE-nick presence tag would equal
  the DM tag for that same nick and the OS would coalesce alice's DM banner
  with alice's presence banner, each overwriting the other. `:` is excluded
  from both `nickname` and `chanstring` in RFC 2812, so no legal message
  tag can ever collide with this one.

  The nick FOLDS in the tag (and only there): flaps of `Alice` and `alice`
  coalesce under one banner, and an online banner replaces the stale
  offline one for the same nick — free OS-level flap coalescing. The title
  and the deep link keep the nick RAW, per the key/display split.
  """
  @spec build_presence(nick :: String.t(), :online | :offline, network_slug :: String.t()) :: t()
  def build_presence(nick, presence, network_slug)
      when is_binary(nick) and presence in [:online, :offline] and is_binary(network_slug) do
    %{
      title: "#{nick} #{presence_verb(presence)}",
      body: "on #{network_slug}",
      tag: "#{network_slug}:presence:#{Identifier.canonical_target(nick)}",
      url: build_url(network_slug, nick)
    }
  end

  defp presence_verb(:online), do: "is online"
  defp presence_verb(:offline), do: "went offline"

  @doc """
  Stamps the PWA icon-badge count onto a built payload (door #1,
  2026-06-21).

  Kept OUT of `build/2` because the badge needs a DB-backed count
  (`Grappa.Push.BadgeCount`), while `build/2` is a pure transcription of
  the message. `Grappa.Push.Triggers` computes the count on the dispatch
  path and merges it here so the service worker can
  `setAppBadge(payload.badge)` while the app is closed. Payloads built
  without it (or sent by an older server) simply omit the key — the SW's
  `narrowPushPayload` treats `badge` as optional and skips the badge
  update.
  """
  @spec put_badge(t(), non_neg_integer()) :: t()
  def put_badge(payload, badge) when is_map(payload) and is_integer(badge) and badge >= 0 do
    Map.put(payload, :badge, badge)
  end

  # `URI.encode_www_form/1` percent-encodes `#` (channel sigil), `&`
  # (rare but RFC2812-legal channel sigil), and any UTF-8 in the
  # channel name. Spaces become `+`; cic's URL parser uses the
  # standard URLSearchParams which decodes both `+` and `%20`.
  defp build_url(network_slug, target) do
    "/?network=#{URI.encode_www_form(network_slug)}&channel=#{URI.encode_www_form(target)}"
  end
end
