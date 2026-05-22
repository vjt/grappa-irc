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

  alias Grappa.Scrollback.Message

  @typedoc """
  Wire shape consumed by `Grappa.Push.Sender.send_to_subscription/2`.
  Same shape as `t:Grappa.Push.Sender.payload/0` (cross-module reference
  not used directly so this module stays free of the cycle through
  `Push.Sender`'s `WebPushElixir` dep).
  """
  @type t :: %{
          required(:title) => String.t(),
          required(:body) => String.t(),
          required(:tag) => String.t(),
          required(:url) => String.t()
        }

  @doc """
  Builds a notification payload for `message` on `network_slug`.

  `own_nick` is the per-(user, network) IRC nick — read from
  `Grappa.Networks.Credential` at the call site, NEVER the account
  name (the two diverge: an account `marcellobarnaba` may be `vjt-grappa`
  on libera and `vjt` on azzurra). Same hazard cic dodged in CP15 H3
  (account name vs IRC nick); the server-side trigger path inherits
  it.

  `dm?` discriminator: `message.channel == own_nick` is the canonical
  rule across the codebase (mirrors `Grappa.Scrollback.dm_peer/4`'s
  inbound branch).
  """
  @spec build(Message.t(), network_slug :: String.t(), own_nick :: String.t()) :: t()
  def build(%Message{} = message, network_slug, own_nick)
      when is_binary(network_slug) and is_binary(own_nick) do
    dm? = message.channel == own_nick
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

  # `URI.encode_www_form/1` percent-encodes `#` (channel sigil), `&`
  # (rare but RFC2812-legal channel sigil), and any UTF-8 in the
  # channel name. Spaces become `+`; cic's URL parser uses the
  # standard URLSearchParams which decodes both `+` and `%20`.
  defp build_url(network_slug, target) do
    "/?network=#{URI.encode_www_form(network_slug)}&channel=#{URI.encode_www_form(target)}"
  end
end
