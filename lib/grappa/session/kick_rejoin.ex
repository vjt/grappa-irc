defmodule Grappa.Session.KickRejoin do
  @moduledoc """
  The opt-in rejoin after a self-KICK (issue 2657) and the guard that keeps
  it from turning into a join flood.

  ## One JOIN per KICK, and why that needs no stop list

  The model is ZNC's `kickrejoin`: on a KICK of our own nick, send ONE
  `JOIN` after the configured delay and never retry it. A JOIN the ircd
  refuses (474 banned, 473 invite-only, 475 bad key, 471 full) does not put
  us back in the channel, so it cannot produce another KICK: there is
  nothing to stop, and the refusal is reported by the `:join_failed` arm
  every JOIN already goes through. The only repetition this feature can
  cause is KICK → rejoin → KICK, and that loop is what the guard closes.

  ## The guard

  Every self-KICK is recorded per channel, whether or not the opt-in is on,
  so switching it on in the middle of a kick loop does not start the count
  from zero. The kick that brings a channel's count inside the last
  `window_ms/0` to `kick_limit/0` is NOT followed by a rejoin: 3 kicks in
  10 minutes, so at most 2 automatic rejoins (vjt's ruling, issue 2657
  decision 3). The window has to satisfy `W ≥ (N−1)·(max_delay + RTT)`, or a
  long delay would let the kicks age out before the count ever reached N.

  ## Shape

  Pure data, no process, no timer: the stamps live in `Session.Server`'s
  state and `now_ms` is supplied by the caller, as in
  `Grappa.Session.AutoReplyBudget`, so the guard is testable without
  sleeping. A crash forgets the count, which is acceptable: the respawn
  rejoins the channel anyway through the #2317 rejoin plan.
  """

  alias Grappa.Networks.Credential

  @kick_limit 3
  @window_ms :timer.minutes(10)

  # One second of rejoin delay, in milliseconds. Only `config/test.exs` sets
  # it, so a test can watch a 10 s delay being honoured without spending
  # 10 s; production takes the default.
  @second_ms Application.compile_env(:grappa, [:session, :kick_rejoin_second_ms], 1000)

  @typedoc """
  What the session does after a self-KICK: nothing, or one JOIN after the
  delay. It is the credential's own type, named here and not restated: a
  typespec names a module without calling it, so it is no Boundary edge, and
  the closed set of delays stays written once, in `Credential`.
  """
  @type config :: Credential.kick_rejoin()

  @typedoc """
  Self-KICK stamps (monotonic ms) per folded channel, newest first, holding
  only the stamps inside the window.
  """
  @type kicks :: %{(channel :: String.t()) => [kicked_at_ms :: integer(), ...]}

  @doc "How many self-KICKs inside `window_ms/0` end the automatic rejoins."
  @spec kick_limit() :: unquote(@kick_limit)
  def kick_limit, do: @kick_limit

  @doc "The length of the window the kicks are counted in, in milliseconds."
  @spec window_ms() :: unquote(@window_ms)
  def window_ms, do: @window_ms

  @doc "The timer delay, in milliseconds, of a configured rejoin delay."
  @spec delay_ms(Credential.kick_rejoin_delay()) :: non_neg_integer()
  def delay_ms(delay_seconds) when is_integer(delay_seconds) and delay_seconds >= 0,
    do: delay_seconds * @second_ms

  @doc """
  Records a self-KICK on `channel` at `now_ms` and says whether it may be
  followed by a rejoin. Stamps older than the window are dropped for every
  channel, so the map holds only what the next verdict can still read.
  """
  @spec record_kick(kicks(), String.t(), integer()) :: {:rejoin | :stay_out, kicks()}
  def record_kick(kicks, channel, now_ms) when is_map(kicks) and is_binary(channel) and is_integer(now_ms) do
    recent = prune(kicks, now_ms)
    stamps = [now_ms | Map.get(recent, channel, [])]
    verdict = if length(stamps) < @kick_limit, do: :rejoin, else: :stay_out

    {verdict, Map.put(recent, channel, stamps)}
  end

  @doc """
  True when `kicked_at_ms` is the latest self-KICK recorded on `channel`. A
  timer armed by an older kick must not fire on behalf of a newer one, or it
  would cut the newer kick's delay short.
  """
  @spec latest_kick?(kicks(), String.t(), integer()) :: boolean()
  def latest_kick?(kicks, channel, kicked_at_ms)
      when is_map(kicks) and is_binary(channel) and is_integer(kicked_at_ms) do
    match?([^kicked_at_ms | _], Map.get(kicks, channel, []))
  end

  @spec prune(kicks(), integer()) :: kicks()
  defp prune(kicks, now_ms) do
    for {channel, stamps} <- kicks,
        recent = Enum.filter(stamps, &(now_ms - &1 < @window_ms)),
        recent != [],
        into: %{},
        do: {channel, recent}
  end
end
