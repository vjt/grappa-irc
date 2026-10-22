defmodule Grappa.Session.E2eKeyAnswers do
  @moduledoc """
  How often grappa answers a peer's KEYREQ with KEYS for its subject
  (issue 2430). Pure data: `Grappa.Session.Server` holds one in its state
  and asks it before every answer.

  Anyone on the network can send a KEYREQ, and every answer costs the
  subject two things: a one-time key from each listed device's bundle
  (each is handed out once, then only the device's fallback key is left
  until it replenishes), and fake-lag bank on the connection, the bank the user's
  own messages and every other E2E line wait on. So the answers are
  bounded on both, with w2's numbers (agreed on 2430, the same irc-olm
  uses):

    * per folded nick, one KEYS answer per `nick_interval_ms/0`, half of
      irc-olm's KEYREQ retry, so an honest peer that asks again is answered
      while a stranger hammering one nick is not; and a one-time key in it
      at most once per `otk_interval_ms/0` (else the fallback key);
    * per connection, at most `otks_per_hour/0` answers carrying one-time
      keys an hour: one key per listed device in each (wire v2), so that
      many of each device's keys;
    * per connection, KEYS answers spend at most `bank_budget_ms/0` of
      fake-lag bank in any `bank_window_ms/0`, except that a window with
      nothing spent affords one answer whatever it costs (`afford?/3`). The per-nick limits alone
      leave the aggregate open to anyone with several nicks, and the
      pacer's REACTIVE budgets rank an answer behind text past them but
      never refuse it. The session's 128 queued urgent and reactive lines
      are shared with the user's own orders and NACKs, and four nicks
      asking every 15 s (each holding up to 32 lines) would fill them with
      answers faster than the bank drains them: every order the user
      answers would be refused. irc-olm needs no such bound, having no
      shared cap; grappa keeps it (orchestrator's ruling on 2430).

  A request past a bound is not answered and not remembered: the peer asks
  again later. Remembering it would be state a stranger controls.

  What is kept is bounded by the windows, never by how many nicks ever
  asked: every call drops what has left its window.
  """

  @nick_interval_ms 15_000
  @otk_interval_ms 60_000
  @otks_per_hour 30
  @hour_ms 3_600_000
  @bank_budget_ms 22_000
  @bank_window_ms 60_000

  @typedoc "What an answer carries: a one-time key, or the fallback key."
  @type kind :: :otk | :fallback

  # `answered`: folded nick => when it was last answered. `otk_given`:
  # folded nick => when it last got a one-time key. `otks`: when each
  # one-time key of the last hour went out. `spent`: `{at, cost_ms}` of each
  # answer in the bank window.
  @enforce_keys [:answered, :otk_given, :otks, :spent]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          answered: %{String.t() => integer()},
          otk_given: %{String.t() => integer()},
          otks: [integer()],
          spent: [{integer(), non_neg_integer()}]
        }

  @doc "How often one nick gets a KEYS answer."
  @spec nick_interval_ms() :: 15_000
  def nick_interval_ms, do: @nick_interval_ms

  @doc "How often one nick gets a one-time key."
  @spec otk_interval_ms() :: 60_000
  def otk_interval_ms, do: @otk_interval_ms

  @doc "Answers carrying one-time keys (one per listed device) the connection sends in any hour."
  @spec otks_per_hour() :: 30
  def otks_per_hour, do: @otks_per_hour

  @doc "Fake-lag bank KEYS answers may spend in any `bank_window_ms/0`."
  @spec bank_budget_ms() :: 22_000
  def bank_budget_ms, do: @bank_budget_ms

  @doc "The sliding window `bank_budget_ms/0` is counted over."
  @spec bank_window_ms() :: 60_000
  def bank_window_ms, do: @bank_window_ms

  @doc "Nothing answered yet."
  @spec new() :: t()
  # Same call as `Grappa.IRC.FakeLag.new/0`: the success typing is the
  # empty singleton, and the result is stored in a field typed `t()`.
  @dialyzer {:nowarn_function, new: 0}
  def new, do: %__MODULE__{answered: %{}, otk_given: %{}, otks: [], spent: []}

  @doc """
  Whether the folded nick `key` may be answered at monotonic `now_ms`, and
  with what: `{:ok, :otk}` when it may have a one-time key, `{:ok,
  :fallback}` when only the fallback key, `{:error, :too_soon}` when it
  was answered less than `nick_interval_ms/0` ago.
  """
  @spec admit(t(), String.t(), integer()) :: {:ok, kind()} | {:error, :too_soon}
  def admit(%__MODULE__{} = answers, key, now_ms) when is_binary(key) and is_integer(now_ms) do
    cond do
      within?(Map.get(answers.answered, key), @nick_interval_ms, now_ms) -> {:error, :too_soon}
      within?(Map.get(answers.otk_given, key), @otk_interval_ms, now_ms) -> {:ok, :fallback}
      Enum.count(answers.otks, &within?(&1, @hour_ms, now_ms)) >= @otks_per_hour -> {:ok, :fallback}
      true -> {:ok, :otk}
    end
  end

  @doc """
  True when an answer costing `cost_ms` of fake-lag bank fits the
  connection's KEYS budget at `now_ms`. A window with nothing spent in it
  affords one answer whatever it costs: a KEYS for four devices (wire v2)
  costs more than the whole budget, and would otherwise never be answered.
  It then fills the window on its own, so the bound still holds over any
  `bank_window_ms/0`: one such answer.
  """
  @spec afford?(t(), non_neg_integer(), integer()) :: boolean()
  def afford?(%__MODULE__{} = answers, cost_ms, now_ms) when is_integer(cost_ms) and is_integer(now_ms) do
    spent = for {at, cost} <- answers.spent, within?(at, @bank_window_ms, now_ms), reduce: 0, do: (n -> n + cost)
    spent == 0 or spent + cost_ms <= @bank_budget_ms
  end

  @doc """
  Records an answer to `key` carrying a `kind` key and costing `cost_ms`,
  sent at `now_ms`, and drops whatever has left its window.
  """
  @spec record(t(), String.t(), kind(), non_neg_integer(), integer()) :: t()
  def record(%__MODULE__{} = answers, key, kind, cost_ms, now_ms)
      when is_binary(key) and kind in [:otk, :fallback] and is_integer(cost_ms) and is_integer(now_ms) do
    otk_given = if kind == :otk, do: Map.put(answers.otk_given, key, now_ms), else: answers.otk_given
    otks = if kind == :otk, do: [now_ms | answers.otks], else: answers.otks

    %__MODULE__{
      answered:
        answers.answered |> Map.put(key, now_ms) |> Map.filter(fn {_, at} -> within?(at, @nick_interval_ms, now_ms) end),
      otk_given: Map.filter(otk_given, fn {_, at} -> within?(at, @otk_interval_ms, now_ms) end),
      otks: Enum.filter(otks, &within?(&1, @hour_ms, now_ms)),
      spent: Enum.filter([{now_ms, cost_ms} | answers.spent], fn {at, _} -> within?(at, @bank_window_ms, now_ms) end)
    }
  end

  @spec within?(integer() | nil, pos_integer(), integer()) :: boolean()
  defp within?(nil, _, _), do: false
  defp within?(at, window_ms, now_ms), do: now_ms - at < window_ms
end
