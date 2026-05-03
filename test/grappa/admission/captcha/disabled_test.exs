defmodule Grappa.Admission.Captcha.DisabledTest do
  @moduledoc """
  The Disabled impl is the test/dev/operator-private default. Its
  contract is "always :ok regardless of inputs" — verify that.
  """
  use ExUnit.Case, async: true

  alias Grappa.Admission.Captcha.Disabled

  test "returns :ok for a real-looking token" do
    assert Disabled.verify("0x.real-looking-token", "1.2.3.4") == :ok
  end

  test "returns :ok for nil token + nil ip" do
    assert Disabled.verify(nil, nil) == :ok
  end

  test "returns :ok for empty string token" do
    assert Disabled.verify("", "1.2.3.4") == :ok
  end
end
