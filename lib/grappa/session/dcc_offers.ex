defmodule Grappa.Session.DccOffers do
  @moduledoc """
  The DCC SEND offers a session is HOLDING, awaiting the operator's
  consent (issue 2089).

  ## What this is

  An inbound `DCC SEND` that survives `Grappa.Dcc.Policy.admit_offer/1`
  is not acted on. Nothing is dialled and nothing is stored: the offer is
  parked here under a minted handle, announced with
  `Grappa.Session.Wire.dcc_offer/6`, and waits for an accept or a refuse
  through the REST doors. This module is that waiting room.

  It is the consent half of the ruling that a stranger's file needs a
  banner, on the `:invited` pattern — `Grappa.Session.WindowState` is the
  precedent this copies, deliberately and almost line for line: a pure
  struct inside `Session.Server`'s state, mutators that are the only way
  in or out, a ceiling with drop-NEW, and one projection function shared
  by the live event and the cold-subscribe backfill.

  ## Why memory and not a table

  An offer is a live TCP endpoint of the peer's. It is worth nothing the
  moment this process dies, because the socket it names will have been
  answered by nobody and the sender will have moved on — and a row that
  outlived the session would invite an operator to accept a file from an
  address the offer no longer describes. A crash reaps the set for free,
  which is the correct behaviour rather than a loss. The BYTES are a
  different matter and do get a table (`Grappa.Dcc.SpoolFile`): they
  exist, they cost disk, and somebody has to collect them.

  ## Pure data, no process

  This is NOT a GenServer / Agent / Registry, and it arms no timers. The
  session GenServer is the synchronization primitive (mailbox-serialized)
  and it is what receives the expiry message, so the
  `Process.send_after/3` lives on `Session.Server` — the same split
  `Grappa.Session.AwayState` documents for the auto-away debounce, and
  for its third reason: this module owns the offer DATA, a timer is a
  control primitive of the Server's loop.

  ## Why no timer reference is kept

  One `Process.send_after/3` per held offer, and NOTHING cancels it. An
  offer that is accepted or refused before its hold elapses leaves a
  timer that fires into `drop/2` and gets `{:error, :not_held}`, which
  the Server ignores.

  That is deliberate and it is the cheaper design. Keeping the reference
  would buy the cancellation of a message that is already a no-op, and
  cost a ref field whose housekeeping has to stay exactly in step with
  the map it decorates — the parallel structure CLAUDE.md's design
  discipline warns about — plus the `cancel_and_drain/2` race dance at
  every one of the three exits. The waste is bounded and tiny: at most
  `held_cap/0` live timers per session at any instant plus the timers of
  the offers resolved since, each a BEAM timer of a few words. A stale
  handle cannot expire a fresh offer
  because handles are 16 random bytes from `Grappa.Dcc.mint_slug/0` and
  are never reused.

  The stragglers are bounded by one hold window (`hold_ms/0`), because
  that is the longest a timer can outlive the offer it was armed for.

  ## The handle is minted here, never derived

  `hold/4` mints the `offer_id` itself and hands it back. It is not
  derived from the filename, the peer, or the address: those are all
  peer-supplied, and a handle a peer can predict is a handle a peer can
  resolve on someone else's behalf through the accept door. It is also
  not the spool slug — same minter, two namespaces, see
  `Grappa.Dcc.mint_slug/0`.
  """

  # No `use Boundary` — this module is INTERNAL to the `Grappa.Session`
  # boundary, exactly like its two siblings `WindowState` and
  # `AwayState`. Promoting it would make it a sibling of `Grappa.Session`
  # in the graph while `Session` calls into it, which is a cycle; and the
  # namespace/model carve-out CLAUDE.md allows is for promoted identity
  # and FK SCHEMAS, not for a context's own internals. Its two outbound
  # edges (`Grappa.Dcc.mint_slug/0` and `Grappa.Dcc.Report`) are declared
  # on `Grappa.Session`'s `deps:` instead.

  alias Grappa.Dcc
  alias Grappa.Dcc.Report
  alias Grappa.IRC.DCC.Offer
  alias Grappa.Session.Wire, as: SessionWire

  # The ceiling on concurrently held offers, and the reason it is not
  # `WindowState`'s 64. An invite has no expiry, so that number had to
  # accommodate a real human's genuine backlog of unanswered invitations.
  # An offer expires on its own, so the only thing standing here at once
  # is what arrived inside one hold window — and each entry is a banner
  # competing for the same screen, which is unusable long before the
  # memory matters. 16 is above any plausible genuine count (offers
  # arrive one per human decision on the far side) and far below what a
  # flood produces in a second.
  #
  # Known and accepted gap, shared with `@invited_cap`: the ceiling is
  # per-SESSION, not per-peer, so one hostile peer can occupy the whole
  # queue. The exits are the same ones the invite has — the operator can
  # refuse — plus one the invite lacks, the hold elapsing on its own.
  @held_cap 16

  # How long an offer is held before it expires itself.
  #
  # 🔴 OURS, not ruled. The hold is bounded by the only thing that makes
  # an offer real — the sender's listening socket — and we cannot observe
  # that at all, so the number answers the question we CAN observe: how
  # long a banner may go on claiming a stranger's socket is still there
  # before the claim is likelier false than true. Five minutes is longer
  # than a person at the keyboard (or reading a push on a phone) needs to
  # answer a prompt, and short enough that a banner surviving a coffee
  # break is not still promising a dead endpoint.
  #
  # It is allowed to be a judgement call rather than a safety boundary
  # because the cost of holding too long is bounded and LOUD: accepting a
  # hold that has outlived its sender dials a socket that refuses, and
  # `Grappa.Dcc.Report` says so in the scrollback. No bytes, no silence.
  @hold_seconds 300

  @typedoc """
  One held offer. `offer` is the parsed, still-raw `Offer` — the
  filename is neutralised at PROJECTION rather than at hold, so the
  stored value stays the thing the peer actually sent and there is one
  derivation of the display name rather than two copies to drift.

  `from` is the peer's nick RAW (it is display, and it is what
  `Grappa.Dcc.Report` attributes the delivered row to). `channel` is
  where the banner renders, which for a stranger is `$server` — see
  `EventRouter.ctcp_query_channel/3`.
  """
  @type held :: %{offer: Offer.t(), from: String.t(), channel: String.t()}

  @typedoc """
  The held set, keyed by minted handle. Lives as one field on
  `Session.Server.state/0`.
  """
  @type t :: %__MODULE__{held: %{String.t() => held()}}

  defstruct held: %{}

  @doc """
  Returns an empty held set. Used by `Session.Server.init/1`.
  """
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc """
  The ceiling on concurrently held offers. Public so a caller — and a
  test — reads the number instead of restating it.
  """
  # `unquote(@held_cap)` pins the spec to the compile-time singleton,
  # which is what the success typing is; `pos_integer()` is a
  # `:underspecs` supertype of it and fails the gate.
  @spec held_cap() :: unquote(@held_cap)
  def held_cap, do: @held_cap

  @doc """
  The hold window in milliseconds — what `Session.Server` arms its
  per-offer `Process.send_after/3` with.

  Milliseconds because that is what the timer takes; the constant is
  written in seconds because that is the unit the reasoning is in.
  """
  @spec hold_ms() :: unquote(@hold_seconds * 1000)
  def hold_ms, do: @hold_seconds * 1000

  @doc """
  Holds `offer` from `from`, to be announced in `channel`, and returns
  the minted handle.

  `{:error, :too_many_offers}` at the ceiling. The caller reports that
  through `Grappa.Dcc.Report.render/2`, which already has the sentence —
  the operator must be told why an offer they can see coming never
  appeared.

  The ceiling is enforced HERE and not by a sibling predicate, which is
  where this parts company with `WindowState.invite_admissible?/2`. That
  split exists because re-affirming an invite on a channel already
  `:invited` writes a key that exists and so cannot grow the store, a
  subtlety the caller has to be able to ask about separately. No such
  case exists here: every hold mints a fresh handle, so every hold grows
  the set, and one door that cannot be bypassed beats two that agree by
  convention.

  Refusal is drop-NEW rather than evict-oldest, the same call
  `invite_admissible?/2` makes and for the same reason: under a flood the
  entries already held are the likelier genuine ones, and evicting by age
  would let a flood displace the offer the operator was about to accept.
  """
  @spec hold(t(), Offer.t(), String.t(), String.t()) ::
          {:ok, String.t(), t()} | {:error, :too_many_offers}
  def hold(%__MODULE__{held: held}, %Offer{} = offer, from, channel)
      when is_binary(from) and is_binary(channel) do
    if map_size(held) < @held_cap do
      offer_id = Dcc.mint_slug()
      entry = %{offer: offer, from: from, channel: channel}
      {:ok, offer_id, %__MODULE__{held: Map.put(held, offer_id, entry)}}
    else
      {:error, :too_many_offers}
    end
  end

  @doc """
  Stops holding `offer_id` and hands back what it was holding.

  ONE verb for all three exits — accept, refuse, expiry — because they
  differ only in what the caller does NEXT (start the transfer, say
  nothing, say nothing) and in the `resolution` it puts on
  `Grappa.Session.Wire.dcc_offer_resolved/4`. The removal is identical,
  and a second copy of it under a second name would be the shared data
  model with a type flag rather than the shared verb.

  `{:error, :not_held}` for a handle this set does not carry, unknown and
  already-resolved alike. It is NOT a no-op to swallow: the accept and
  refuse doors are REST doors, so this error is the 404 (CLAUDE.md: no
  silent-swallow at boundaries), and on the expiry path it is the
  ordinary answer for a timer that outlived the offer it was armed for —
  see the moduledoc on why nothing cancels those.
  """
  @spec drop(t(), String.t()) :: {:ok, held(), t()} | {:error, :not_held}
  def drop(%__MODULE__{held: held}, offer_id) when is_binary(offer_id) do
    case Map.pop(held, offer_id) do
      {nil, _} -> {:error, :not_held}
      {entry, rest} -> {:ok, entry, %__MODULE__{held: rest}}
    end
  end

  @doc """
  The `dcc_offer` payload for ONE held offer — what `Session.Server`
  broadcasts the instant it starts holding.

  `{:error, :not_held}` mirrors `drop/2`'s vocabulary rather than
  `WindowState.to_wire/3`'s `:not_tracked`: there is no state here that
  exists but is deliberately not projected, so the only way to miss is to
  name an offer that is not held.
  """
  @spec to_wire(t(), String.t(), String.t()) ::
          {:ok, SessionWire.dcc_offer_payload()} | {:error, :not_held}
  def to_wire(%__MODULE__{held: held}, network_slug, offer_id)
      when is_binary(network_slug) and is_binary(offer_id) do
    case Map.fetch(held, offer_id) do
      {:ok, entry} -> {:ok, payload(network_slug, offer_id, entry)}
      :error -> {:error, :not_held}
    end
  end

  @doc """
  The `dcc_offer` payloads for EVERY held offer — the user-topic
  cold-subscribe backfill, and the body of `GET /dcc_offers`.

  The twin of `WindowState.invited_windows/2` and it exists for the same
  bug in a second costume (#482): the announcement is broadcast once,
  Phoenix PubSub does not replay, so without this a reload leaves the
  operator with a file being held for them that nothing on screen
  mentions — and it expires unanswered.

  Funnels through the same `payload/3` as `to_wire/3`, so a banner drawn
  from the backfill and one drawn from the live event are the same map.
  """
  @spec held_offers(t(), String.t()) :: [SessionWire.dcc_offer_payload()]
  def held_offers(%__MODULE__{held: held}, network_slug) when is_binary(network_slug) do
    for {offer_id, entry} <- held, do: payload(network_slug, offer_id, entry)
  end

  # The one projection. `display_filename/1` rather than the raw name is
  # the whole point of neutralising at projection: this event and the
  # scrollback row `Grappa.Dcc.Report` writes afterwards are the two
  # places a reader compares, and they must name the file identically.
  # `size` is forwarded as the CLAIM it is — the operator is consenting
  # to a stated size, and the transfer truncates at it.
  defp payload(network_slug, offer_id, %{offer: offer, from: from, channel: channel}) do
    SessionWire.dcc_offer(
      network_slug,
      channel,
      offer_id,
      from,
      Report.display_filename(offer.filename),
      offer.size
    )
  end
end
