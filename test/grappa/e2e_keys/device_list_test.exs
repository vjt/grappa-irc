defmodule Grappa.E2eKeys.DeviceListTest do
  @moduledoc """
  issue 2430, multi-device — the string a master signs over its device
  list is wire (2430 comment 6346236542): pinned here as a literal, so a
  drift in `signed_string/2` is red rather than signed both ways.
  """
  use ExUnit.Case, async: true

  alias Grappa.E2eKeys.DeviceList

  test "signed_string/2 is the prefix, the decimal version, and the keys joined by commas" do
    a = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo"
    b = "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw"

    assert DeviceList.signed_string(1, [a]) == "irc-e2e:v2:list:1:" <> a
    assert DeviceList.signed_string(12, [a, b]) == "irc-e2e:v2:list:12:" <> a <> "," <> b
  end
end
