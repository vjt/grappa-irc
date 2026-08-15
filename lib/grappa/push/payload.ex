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

    * **DM** (`channel == own_nick`): `title = sender`, body =
      message body verbatim. Notification shape mirrors how mobile
      messengers surface a 1:1 chat — sender on top line, content on
      second.
    * **Channel** (everything else): `title = "<sender> in <channel>"`,
      body = message body verbatim. Reader sees both who spoke and
      where in one glance.

  ## Presence transitions (#378)

  `build_presence/3` is the sibling constructor for a `/notify` presence
  flip. It returns the same `t()` and needs no service-worker change, but
  it is a SEPARATE function rather than a clause of `build/3`: that one is
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

  alias Grappa.IRC.Identifier
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

  `own_nick` is the per-(user, network) IRC nick — read from
  `Grappa.Networks.Credential` at the call site, NEVER the account
  name (the two diverge: an account `marcellobarnaba` may be `vjt-grappa`
  on libera and `vjt` on azzurra). Same hazard cic dodged in CP15 H3
  (account name vs IRC nick); the server-side trigger path inherits
  it.

  `dm?` discriminator: the inbound row's `channel` KEY equals own_nick
  (mirrors `Grappa.Scrollback.dm_peer/4`'s inbound branch). #537 — the
  `channel` KEY is folded at the persist boundary, so the compare folds
  BOTH sides (`canonical_target/1`) or a mixed-case own_nick misses its
  own folded DM rows.
  """
  @spec build(Message.t(), network_slug :: String.t(), own_nick :: String.t()) :: t()
  def build(%Message{} = message, network_slug, own_nick)
      when is_binary(network_slug) and is_binary(own_nick) do
    dm? =
      is_binary(message.channel) and
        Identifier.canonical_target(message.channel) ==
          Identifier.canonical_target(own_nick)

    sender = message.sender || ""
    body = message.body || ""

    {title, dedup_key, deep_link_target} =
      if dm? do
        {sender, sender, sender}
      else
        {"#{sender} in #{message.channel}", message.channel, message.channel}
      end

    %{
      title: title,
      body: body,
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
  load-bearing, not decoration: `build/3` writes
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

  Kept OUT of `build/3` because the badge needs a DB-backed count
  (`Grappa.Push.BadgeCount`), while `build/3` is a pure transcription of
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
