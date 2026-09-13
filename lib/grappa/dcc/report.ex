defmodule Grappa.Dcc.Report do
  @moduledoc """
  Turns a DCC outcome into the scrollback row that tells the user about
  it (issue 2089).

  Issue 2089's hardest rule is that **nothing is silent**: a refused
  connect, a size or quota rejection, a truncated or aborted transfer, a
  declined or expired offer — each earns a row in the conversation the
  offer arrived in. This module owns the wording for all of them, so the
  outcomes cannot drift into two vocabularies. Its input is the typed
  reasons the parser and the transport already return; it does not
  invent a second taxonomy over them.

  ## Who the row is attributed to, and why the two halves differ

  A DELIVERED file is the peer speaking: they initiated the transfer, so
  the row carries their nick RAW-cased (a nick's case is presentation)
  and the content kind `:privmsg`. That also means it pushes and counts
  as unread, which is what a user wants when a file lands.

  A FAILURE is not. "The connection was refused" is grappa's sentence,
  not the peer's, and attributing it to their nick would put words in a
  stranger's mouth inside the user's own scrollback. Those rows use
  `Grappa.IRC.Message.anonymous_sender/0` and the event-tier kind
  `:server_event` — the same pair, for the same stated reason, as the
  `$server` link-failure row in `Session.Server`: nobody said this, and
  it did not come off the wire. The consequence is deliberate:
  `:server_event` does not push, so a failure informs without buzzing a
  phone.

  ⚠️ This splits a brief that said the synthesised message is attributed
  to the peer's nick. That reading holds for the delivered half and is
  followed; applying it to the failure half would have manufactured peer
  speech.

  ## The emoji is a TYPE SIGNAL, not decoration

  cic keys inline media rendering off a closed emoji map — 📸 image, 🎬
  video, 🎵 audio (`cicchetto/src/lib/mediaLink.ts`). A DCC file is
  arbitrary stranger-pushed bytes, served `application/octet-stream` +
  `Content-Disposition: attachment` + `nosniff`, and issue 2089 forbids
  any content sniff that PROMOTES a type. So the prefix is 📥,
  deliberately OUTSIDE that map: the file gets a link and never an
  inline render. Picking one of the three would have made the renderer
  the sniffer.

  ## The filename is neutralised HERE, not in the parser

  `Grappa.IRC.DCC` keeps the peer's filename verbatim because it is
  evidence of what was actually sent. This is the display boundary, so
  this is where it is made safe to render: control bytes go (a `\\x01`
  or a mIRC `\\x03` run inside a filename must not reach a rendered row,
  and a CRLF must not forge a second line) and the length is capped so
  one offer cannot flood a row. Non-ASCII is untouched — the strip is
  control characters, not a charset policy.

  No attempt is made to defeat a filename that merely LOOKS like a URL.
  A peer who can send a DCC offer can already send a PRIVMSG containing
  any text they like, so that is not a capability this path adds, and a
  filter that mangled legitimate names to chase it would cost more than
  it buys.

  ## v1 emits BODY TEXT and no new wire field

  The `Grappa.Scrollback.Meta` docs for the link-failure row set the
  pattern: the body carries the reason spelled for a human, and a
  structured copy is what a future client would style. v1's surface is
  the synthesised message alone, so there is no new `meta` variant here
  — which also means no wire-shape change and no `protocol_version`
  bump. Adding one later is additive, at the cost of that bump.
  """

  use Boundary, top_level?: true, deps: [Grappa.IRC]

  # `Transfer` is named only in a typespec, which is metadata rather
  # than an xref edge — hence no `Grappa.Dcc.Transfer` in `deps:` above,
  # and the forced compile agrees.
  alias Grappa.Dcc.Transfer
  alias Grappa.IRC.{DCC, Message}

  @prefix "📥"
  @filename_max_bytes 120
  @unnamed "(unnamed)"

  @enforce_keys [:kind, :sender, :body]
  defstruct [:kind, :sender, :body]

  @type t :: %__MODULE__{
          kind: :privmsg | :server_event,
          sender: String.t(),
          body: String.t()
        }

  @typedoc """
  What happened to an offer. `:refused` carries no filename because a
  malformed offer may not have yielded one.
  """
  @type outcome ::
          {:delivered, String.t(), String.t()}
          | {:failed, String.t(), Transfer.failure()}
          | {:refused, DCC.refusal()}

  @doc """
  Renders `outcome` into the row to persist, for an offer from
  `peer_nick`.
  """
  @spec render(outcome(), String.t()) :: t()
  def render({:delivered, filename, url}, peer_nick) when is_binary(url) do
    %__MODULE__{
      kind: :privmsg,
      sender: peer_nick,
      body: "#{@prefix} #{display(filename)} — #{url}"
    }
  end

  def render({:failed, filename, failure}, peer_nick) do
    event("#{peer_nick}'s file #{display(filename)} did not arrive: #{failure_reason(failure)}")
  end

  def render({:refused, refusal}, peer_nick) do
    event("DCC offer from #{peer_nick} declined: #{refusal_reason(refusal)}")
  end

  defp event(body), do: %__MODULE__{kind: :server_event, sender: Message.anonymous_sender(), body: body}

  defp failure_reason(:connect_refused), do: "the offered address refused the connection"
  defp failure_reason(:connect_timeout), do: "the offered address never answered"
  defp failure_reason(:idle_timeout), do: "the sender stopped sending"

  defp failure_reason({:short_transfer, received, declared}),
    do: "the sender closed after #{received} of the #{declared} bytes it promised"

  defp failure_reason({:tcp, reason}), do: "the connection failed (#{inspect(reason)})"
  defp failure_reason({:fs, reason}), do: "it could not be stored (#{inspect(reason)})"

  defp refusal_reason(:passive_unsupported),
    do: "passive (reverse) DCC asks this bouncer to listen, which it never does"

  defp refusal_reason({:unsupported_subcommand, verb}), do: "DCC #{verb} is not supported"
  defp refusal_reason(:malformed), do: "the offer could not be understood"

  # Control bytes out, length capped, and a name that was ENTIRELY
  # control bytes still yields something to print rather than an empty
  # pair of quotes.
  defp display(filename) do
    cleaned =
      filename
      |> String.replace(~r/\p{C}/u, "")
      |> String.trim()
      |> truncate()

    case cleaned do
      "" -> @unnamed
      name -> ~s{"#{name}"}
    end
  end

  defp truncate(name) when byte_size(name) <= @filename_max_bytes, do: name

  defp truncate(name) do
    name
    |> binary_part(0, @filename_max_bytes)
    |> String.chunk(:valid)
    |> List.first()
    |> Kernel.<>("…")
  end
end
