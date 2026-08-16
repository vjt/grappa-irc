defmodule Grappa.Session.AutoReplyBudget do
  @moduledoc """
  The ceiling on UNSOLICITED outbound answers one session emits on remote
  command — today the CTCP VERSION / PING auto-replies.

  Two quantities are bounded by the same token, because one query produces
  both: a line to the upstream socket, and a visibility row in the shared
  sqlite file. Metering only the line would leave the writes uncapped;
  metering them separately would let the scrollback claim an answer that
  never went out.

  ## Why this is not the #340 bucket

  `Grappa.RateLimit.TokenBucket` meters the SUBJECT's own sends. A human
  paces those, the key is `(subject, network)`, and a node-global
  GenServer is the right home for it.

  This budget meters answers a STRANGER paces. Sending a remote-paced path
  through a node-global process hands every peer on every bound network
  the ability to enqueue a serialized call for the whole node — a bound
  that relocates the flood rather than stopping it. So the arithmetic is
  pure and the bucket lives in the state of the session that owns it: no
  shared process, no shared table, and — the reason a per-sender ledger
  was rejected too — no keyspace that grows with the number of strangers
  who ask. A per-sender bound would also miss the aggregate, which is the
  quantity the upstream actually meters.

  ## Shape

  Lazy refill, no timer: `tokens + elapsed_s * refill`, capped at
  `capacity`, computed on access. This mirrors `TokenBucket`'s model
  deliberately — same arithmetic, different home. A fresh budget starts
  FULL, so a session that has answered nothing answers the first query
  immediately.

  `now_ms` is supplied by the caller (`System.monotonic_time(:millisecond)`
  in production) rather than read here, which is what makes refill
  behaviour testable without sleeping.
  """

  # Deliberately the ORDINARY send drip of #340 (`config :grappa,
  # :send_throttle`), not a number of its own: an answer grappa emits on a
  # stranger's command may not consume more of the upstream's allowance
  # than the operator's own client is allowed to consume. Tying the two
  # together also means an operator who re-measures their network's
  # allowance moves one pair of numbers, not two that drift.
  @capacity Application.compile_env(:grappa, [:auto_reply_budget, :capacity], 5)
  @refill_per_sec Application.compile_env(:grappa, [:auto_reply_budget, :refill_per_sec], 0.5)

  @typedoc """
  Remaining tokens plus the monotonic stamp they were computed at.
  """
  @type t :: %{tokens: float(), last_ms: integer()}

  @doc """
  A full budget stamped at `now_ms`.
  """
  @spec new(integer()) :: t()
  def new(now_ms) when is_integer(now_ms) do
    %{tokens: @capacity * 1.0, last_ms: now_ms}
  end

  @doc """
  Refill for the elapsed time, then try to consume one token.

  `{:ok, budget}` when a token was available and consumed;
  `{:error, :rate_limited, budget}` when it was not. Both arms return the
  refilled budget — a denied take still advances the clock, so the next
  call refills from here instead of re-crediting the same interval.
  """
  @spec take(t(), integer()) :: {:ok, t()} | {:error, :rate_limited, t()}
  def take(%{tokens: tokens, last_ms: last_ms}, now_ms) when is_integer(now_ms) do
    elapsed_s = (now_ms - last_ms) / 1000
    refilled = min(@capacity * 1.0, tokens + elapsed_s * @refill_per_sec)

    if refilled >= 1.0 do
      {:ok, %{tokens: refilled - 1.0, last_ms: now_ms}}
    else
      {:error, :rate_limited, %{tokens: refilled, last_ms: now_ms}}
    end
  end

  @doc """
  The configured burst allowance — exposed so a test states the ceiling by
  reading it rather than by re-typing the number.
  """
  @spec capacity() :: pos_integer()
  def capacity, do: @capacity

  @doc """
  The configured sustained refill rate, in tokens per second.
  """
  @spec refill_per_sec() :: number()
  def refill_per_sec, do: @refill_per_sec
end
