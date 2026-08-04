defmodule Grappa.IRC.FakeLag do
  @moduledoc """
  #800 S7 — what our own outbound traffic would cost us under an ircd's
  flood throttle, computed from the frames we actually send.

  ## Why this exists

  #800 measured that one extra command on the upstream connection delays
  the operator's *next* message by seconds (`nick-follow-query`: 2.7s
  baseline → 6.7s and a timeout once the rail issued a speculative
  WHOIS). #805 removed that command, and the rule it established — a pane
  may not spend a budget it cannot see — rests on that displacement result
  alone.

  What stayed open is WHERE those seconds are spent. The leading
  hypothesis is bahamut's fake lag: every command advances a per-client
  `since` clock by `2 + len/120` seconds, and the server stops draining
  that client's recvQ while `since - now >= 10`
  (`parse.c:236`, `s_bsd.c:1657`). **That hypothesis comes from reading
  bahamut's source. Nobody has instrumented a running ircd.** Re-reading
  the source cannot close it.

  This module closes the half of it that lives on OUR side of the socket:
  it makes the bank a number grappa observes about itself, per frame, on a
  live connection. If the modelled bank sits near zero at the moment a
  send is measurably delayed, fake lag is dead as an explanation without
  anyone having to touch the ircd.

  ## Measured vs modelled — read the fields accordingly

    * **Measured** — `commands_10s` and the per-frame byte count: what
      grappa put on the wire, and when. Facts about this process.
    * **Modelled** — `penalty_10s_s`, `bank_model_s` and `headroom_s`:
      what bahamut's published arithmetic WOULD charge for those frames,
      and how far that leaves us from the drain gate. A model of a remote
      server, evaluated locally. It is not a reading off the ircd and must
      never be quoted as one.

  Two numbers are reported, not one, because they answer two different
  questions. `bank_model_s` says how much debt this connection carries;
  `headroom_s` (`10 − bank`) says how close that debt is to the point
  where the server stops reading us. A large bank with ample headroom is
  not the same finding as a bank pressed against the gate, and #800's
  claim — that the cost only bites on a connection already near the
  ceiling after hundreds of preceding specs — is a claim about the SECOND
  number. It has never been measured. Note that `since` is compared
  against wall-clock `now`, so the bank drains in real time and cannot
  accumulate across a 25-minute run; whether that is what actually
  happens is what these numbers report.

  Because `Grappa.IRC.Client` logs every frame's verb and byte count
  alongside the aggregate, a reader who thinks the model charges the
  wrong thing (bahamut may exempt `PONG`; opers are exempt outright) can
  re-derive the bank from the raw lines rather than trust this arithmetic.

  ## The arithmetic

  `cost = 2 + div(bytes, 120)` seconds — **integer** division, mirroring
  the C. A 64-byte PRIVMSG and a 119-byte one cost the same flat 2s; the
  step to 3s lands at 120 bytes. `bytes` is the frame as written to the
  socket, CRLF included, which can only differ from what bahamut counts
  within two bytes of a 120-byte boundary.

  The bank advances `since = max(since, now) + cost`, so idling drains it
  and it never goes negative: a connection quiet for longer than its debt
  starts the next command from the flat floor.

  **Known divergence, above the gate.** This model advances the bank when
  *we write*; bahamut advances it when *it parses*, and past the gate it
  stops parsing, so the real bank saturates near the ceiling while ours
  keeps climbing. A modelled bank far above ten therefore reads as "we
  wrote considerably more than the server could drain" — a strong signal,
  but not a literal server-side figure. Below the gate the two track.

  ## Scope

  Per-connection, in-process, driven by `Grappa.IRC.Client`'s outbound
  choke point — so the registration burst, liveness PINGs and PONGs count
  too, not just session-issued commands. A model fed only the commands we
  find convenient would under-count, and an under-count is precisely what
  would kill the hypothesis for the wrong reason.

  Diagnostic instrumentation: it changes nothing about what is sent or
  when. Pure — the caller supplies the clock reading.
  """

  # The recvQ-drain gate bahamut applies is `since - now < 10` seconds, so
  # ten seconds is the horizon over which past commands can still be
  # holding the connection back. Anything older cannot be part of the
  # explanation for a send that is slow right now.
  @window_ms 10_000

  # The same ten seconds seen as a ceiling: at or past it, bahamut stops
  # draining our recvQ, which is the moment a queued command starts
  # waiting on the clock instead of on the server.
  @ceiling_s 10.0

  # `2 + len/120` from parse.c, in the C's own integer arithmetic.
  @flat_cost_s 2
  @bytes_per_second 120

  @type sample :: %{
          commands_10s: non_neg_integer(),
          penalty_10s_s: float(),
          bank_model_s: float(),
          headroom_s: float(),
          ceiling_s: float()
        }

  @typedoc """
  `since_ms` is the modelled bank clock — `nil` until the first frame, so
  a fresh connection cannot inherit a phantom debt. `window` holds
  `{sent_at_ms, cost_ms}` newest-first, pruned to `@window_ms` on every
  record, which is what bounds it on a long-lived connection.
  """
  @type t :: %__MODULE__{since_ms: integer() | nil, window: [{integer(), pos_integer()}]}

  defstruct since_ms: nil, window: []

  @doc "A connection that has sent nothing yet."
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc """
  Account for one outbound frame of `bytes` sent at `now_ms`, and return
  the updated state plus the sample to report.

  `now_ms` is a monotonic-clock reading in milliseconds — it may be
  negative, and only differences between readings are meaningful.

  Accepts a zero-byte frame rather than guarding it out: this runs on the
  session's only outbound path, and instrumentation that can raise there
  would take a live IRC connection down over a diagnostic.
  """
  @spec record(t(), non_neg_integer(), integer()) :: {t(), sample()}
  def record(%__MODULE__{} = state, bytes, now_ms)
      when is_integer(bytes) and bytes >= 0 and is_integer(now_ms) do
    cost_ms = cost_ms(bytes)
    since_ms = bank_base(state.since_ms, now_ms) + cost_ms
    window = [{now_ms, cost_ms} | prune(state.window, now_ms)]

    {%__MODULE__{since_ms: since_ms, window: window}, sample(window, since_ms, now_ms)}
  end

  # Two clauses rather than `max(since_ms || now_ms, now_ms)`: in Erlang's
  # term order every integer sorts BELOW `nil`, so a `max/2` over a nil
  # bank would quietly return `nil` and poison the arithmetic downstream
  # (the `feedback_monotonic_guard_nil_term_order_footgun` trap).
  @spec bank_base(integer() | nil, integer()) :: integer()
  defp bank_base(nil, now_ms), do: now_ms
  defp bank_base(since_ms, now_ms) when is_integer(since_ms), do: max(since_ms, now_ms)

  @spec cost_ms(pos_integer()) :: pos_integer()
  defp cost_ms(bytes), do: (@flat_cost_s + div(bytes, @bytes_per_second)) * 1_000

  @spec prune([{integer(), pos_integer()}], integer()) :: [{integer(), pos_integer()}]
  defp prune(window, now_ms), do: Enum.filter(window, fn {at, _} -> now_ms - at <= @window_ms end)

  @spec sample([{integer(), pos_integer()}], integer(), integer()) :: sample()
  defp sample(window, since_ms, now_ms) do
    penalty_ms = Enum.reduce(window, 0, fn {_, cost}, acc -> acc + cost end)
    bank_s = to_s(since_ms - now_ms)

    %{
      commands_10s: length(window),
      penalty_10s_s: to_s(penalty_ms),
      bank_model_s: bank_s,
      # Goes NEGATIVE past the gate rather than clamping at zero: the
      # command that crosses it is still parsed, and "how far over" is
      # the interesting number once we are over.
      headroom_s: @ceiling_s - bank_s,
      ceiling_s: @ceiling_s
    }
  end

  @spec to_s(integer()) :: float()
  defp to_s(ms), do: ms / 1_000
end
