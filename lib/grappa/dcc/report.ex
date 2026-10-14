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

  ⚠️ **Issue 2127 put an EXTENSION on the URL, and that does not reopen
  this.** `mediaLink.ts` has two separate type rules and they are not
  interchangeable. Rule 2 is the emoji map, and it fires only on the
  legacy extensionless `/uploads/<slug>` path shape — a `/dcc_files/…`
  URL cannot reach it whatever emoji precedes it, which is why 📥 staying
  outside the map is still the whole of this paragraph's guarantee. Rule
  3 keys on the URL extension, and what it changes is what a CLICK does:
  the viewer is on-click only, never on arrival. 2089's rule was "never
  an INLINE render", and that survives untouched — nothing here renders
  a stranger's bytes into scrollback.

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

  # issue 2185 dropped `Grappa.Dcc`: the decline line used to re-read
  # `Dcc.max_transfer_bytes/0`, and now the ceiling arrives inside the
  # refusal term. The module is PURE again — no Repo behind any sentence
  # it renders, which is what lets its test stay a plain `ExUnit.Case`.
  use Boundary, top_level?: true, deps: [Grappa.Dcc.Policy, Grappa.IRC]

  # `Transfer` is named only in a typespec, which is metadata rather
  # than an xref edge — hence no `Grappa.Dcc.Transfer` in `deps:` above,
  # and the forced compile agrees.
  alias Grappa.Dcc.{Policy, Transfer}
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

  Its reason spans TWO vocabularies and deliberately so: the parser's
  (`t:Grappa.IRC.DCC.refusal/0` — this is not a DCC offer we implement) and
  the policy gate's (`t:Grappa.Dcc.Policy.refusal/0` — it is, and we decline
  it). A reader of the row does not care which layer said no; they care
  what to do next, and this module owns that wording for all of them
  rather than letting a second taxonomy grow beside it.

  `:too_many_offers` belongs to neither: it is the session's held-set
  ceiling, and it is named here because the operator must still be told
  why an offer they can see coming never appeared.
  """
  @type refusal :: DCC.refusal() | Policy.refusal() | :too_many_offers

  @typedoc """
  What happened to an offer.

  The set is TOTAL on purpose: every offer leaves exactly one row here,
  and the reason is that a held offer lives in memory alone. Delivered
  bytes get the peer's own `:privmsg`; a transfer that broke gets
  `:failed`; an offer turned away before any socket existed gets
  `:refused`; and one that nobody answered gets `:expired`. Drop any arm
  and a stranger can offer a file whose entire existence leaves no trace
  in the scrollback.

  `:refused` carries no filename because a malformed offer may not have
  yielded one. `:expired` always does — the offer parsed and was held, so
  the name is in hand.
  """
  @type outcome ::
          {:delivered, String.t(), String.t()}
          | {:failed, String.t(), Transfer.failure()}
          | {:refused, refusal()}
          | {:expired, String.t()}

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

  # Deliberately NOT worded as a refusal. Nobody declined this one — the
  # hold ran out with the banner still on screen — and "declined" would
  # tell the operator they made a decision they did not make.
  def render({:expired, filename}, peer_nick) do
    event("#{peer_nick}'s offer of #{display(filename)} expired unanswered")
  end

  defp event(body), do: %__MODULE__{kind: :server_event, sender: Message.anonymous_sender(), body: body}

  defp failure_reason(:connect_refused), do: "the offered address refused the connection"
  defp failure_reason(:connect_timeout), do: "the offered address never answered"
  defp failure_reason(:idle_timeout), do: "the sender stopped sending"

  defp failure_reason({:short_transfer, received, declared}),
    do: "the sender closed after #{received} of the #{declared} bytes it promised"

  # Issue 2405. What was OBSERVED, not just that a limit tripped: the
  # deadline is derived from the declared size, so "too slow" alone could
  # not tell a stalled trickle from a file that was nearly there.
  defp failure_reason({:too_slow, received, declared, elapsed_ms}) do
    "the sender was too slow: #{received} of the #{declared} bytes it promised " <>
      "arrived in #{div(elapsed_ms, 1_000)} seconds"
  end

  defp failure_reason({:tcp, reason}), do: "the connection failed (#{inspect(reason)})"
  defp failure_reason({:fs, reason}), do: "it could not be stored (#{inspect(reason)})"

  defp refusal_reason(:passive_unsupported),
    do: "passive (reverse) DCC asks this bouncer to listen, which it never does"

  defp refusal_reason({:unsupported_subcommand, verb}), do: "DCC #{verb} is not supported"
  defp refusal_reason(:malformed), do: "the offer could not be understood"

  # The policy gate's four. Each says what the operator can DO about it,
  # which is why the axes were kept separate rather than collapsed into
  # one "refused" — see `Grappa.Dcc.Policy`.
  defp refusal_reason(:ssrf_blocked),
    do: "the offered address is not one this bouncer will dial"

  # The cap comes off the REFUSAL, never off a fresh read: it is an
  # operator setting since issue 2185, and `Grappa.Dcc.Policy.check_size/1`
  # already read the value that said no. A second read here could name a
  # ceiling that refused nothing. It also keeps this module PURE — no
  # Repo, which is why its test still needs no sandbox.
  defp refusal_reason({:too_large, cap}),
    do: "it is larger than the #{megabytes(cap)} MB limit for a DCC transfer"

  defp refusal_reason(:rate_limited),
    do: "you have already accepted #{Policy.daily_accepts()} DCC transfers today"

  defp refusal_reason(:insufficient_storage),
    do: "there is no room left in the DCC spool"

  defp refusal_reason(:too_many_offers),
    do: "too many DCC offers are already waiting for an answer"

  # Whole MB, because a byte count in a sentence a human reads is noise —
  # and ONE decimal place when the ceiling is not a whole number of MiB.
  #
  # 🔴 This was `div/2`, and the comment justifying it rested on a premise
  # issue 2185 removed: *"the cap is a power-of-two multiple of a MiB
  # today"*. It is an operator setting now, and the natural thing for an
  # operator to type is a decimal byte count — 100_000_000 is a 95.367 MiB
  # ceiling that `div/2` printed as **95**, and anything under a MiB it
  # printed as **0**. The decline line is the one sentence that tells the
  # user what to do next; a number it understates by a third of a MB, or
  # collapses to zero, is the paletto this fixes.
  #
  # Truncated (`Float.floor/2`), never rounded up: the printed figure must
  # never sit ABOVE the real limit, or a user resending at exactly the
  # number they read is refused a second time.
  #
  # ⚠️ **Known limit, declared rather than cured:** a ceiling below 0.1 MiB
  # still prints "0". Closing it needs a SECOND unit, and a second unit is
  # more machinery than a configuration nobody sane writes deserves.
  #
  # The alternative — validating the setting to whole MiB — was rejected:
  # every sibling in the `upload.*_cap_bytes` family takes any positive
  # integer, so it would fork the validation shape across two families and
  # refuse a legal byte count to protect a rendering. Fix the rendering.
  defp megabytes(bytes) do
    case Float.floor(bytes / (1024 * 1024), 1) do
      mb when mb == trunc(mb) -> Integer.to_string(trunc(mb))
      mb -> Float.to_string(mb)
    end
  end

  @doc """
  The peer's filename made safe to RENDER — control bytes stripped, length
  capped, and a name that was entirely control bytes collapsed to
  `#{@unnamed}` rather than to nothing.

  Public because the consent banner needs the same string the scrollback
  row uses (`Grappa.Session.Wire.dcc_offer/6` takes it). Two
  neutralisations would be one drift away from a banner and a row naming
  the same file differently, which is the one place a reader compares
  them.

  Bare — no quotes. Quoting is this module's own sentence-level framing
  (`display/1`), not part of the name, and a wire field carrying literal
  quotes would have them rendered.
  """
  @spec display_filename(String.t()) :: String.t()
  def display_filename(filename) when is_binary(filename) do
    case clean(filename) do
      "" -> @unnamed
      name -> name
    end
  end

  # The quoted, in-sentence form. The `#{@unnamed}` sentinel is deliberately
  # NOT quoted — it is this module speaking, not a name the peer chose. The
  # branch is on the CLEANED input rather than on `display_filename/1`'s
  # output, so a peer who literally names a file `#{@unnamed}` still gets
  # quotes and is not silently reported as nameless.
  defp display(filename) do
    case clean(filename) do
      "" -> @unnamed
      name -> ~s{"#{name}"}
    end
  end

  defp clean(filename) do
    filename
    |> String.replace(~r/\p{C}/u, "")
    |> String.trim()
    |> truncate()
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
