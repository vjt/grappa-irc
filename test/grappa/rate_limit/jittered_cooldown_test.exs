defmodule Grappa.RateLimit.JitteredCooldownTest do
  use ExUnit.Case, async: true
  alias Grappa.RateLimit.JitteredCooldown

  describe "compute/2" do
    test "base 0 + any jitter → 0" do
      assert JitteredCooldown.compute(0, 0) == 0
      assert JitteredCooldown.compute(0, 25) == 0
      assert JitteredCooldown.compute(0, 100) == 0
    end

    test "base 1000 + jitter 0 → exactly 1000" do
      assert JitteredCooldown.compute(1000, 0) == 1000
    end

    test "base 1000 + jitter 25 → in [750, 1250]" do
      for _ <- 1..200 do
        v = JitteredCooldown.compute(1000, 25)
        assert v >= 750 and v <= 1250
      end
    end

    test "negative base raises" do
      assert_raise ArgumentError, fn -> JitteredCooldown.compute(-1, 25) end
    end
  end
end
