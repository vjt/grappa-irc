defmodule Grappa.TypeLaundry do
  @moduledoc """
  Type-laundering helper for **negative-type guard tests** under Elixir 1.20+.

  Elixir 1.20's set-theoretic type checker statically flags a call that
  passes a literal wrong-typed value to a function whose guard/spec rejects
  it — even when asserting that rejection is the entire point of the test
  (e.g. `assert_raise FunctionClauseError`). Under `--warnings-as-errors`
  those `"incompatible types given to …"` warnings fail the build.

  `opaque/1` is a **runtime-identity passthrough** whose declared return
  type is `term()`, so the compile-time checker cannot narrow the argument
  type at the call site and stays silent, while runtime behaviour — and
  therefore the test's assertion — is unchanged.

  ## Convention

  Wrap ONLY the deliberately-wrong argument, nothing else:

      import Grappa.TypeLaundry

      assert_raise FunctionClauseError, fn ->
        PubSub.broadcast_event("grappa:user:test", opaque(%URI{scheme: "https"}))
      end

  This is the single sanctioned way to write negative-type guard tests under
  1.20 — do not sprinkle `@dialyzer`/`@compile` suppressions or weaken the
  production guard to appease the checker. See `docs/DESIGN_NOTES.md`
  (2026-07-05, Elixir 1.20 / OTP 29 migration).
  """

  @doc """
  Returns `value` unchanged at runtime; opaque to the compile-time type
  checker (declared `term() :: term()` so no argument-type narrowing leaks
  to the call site).
  """
  @spec opaque(term()) :: term()
  def opaque(value), do: value
end
