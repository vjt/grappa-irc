defmodule Grappa.E2eKeys.LimitsParityTest do
  @moduledoc """
  issue 2430, multi-device — two limits grappa owns and cicchetto mirrors
  as literals, because cic applies them without asking grappa first:

    * `Grappa.E2eKeys.DeviceList.max_devices/0` ↔ `MAX_DEVICES` in
      `cicchetto/src/lib/e2e/wire.ts`: the most keys a list may name and the
      most bodies one message carries;
    * `Grappa.E2eKeys.max_one_time_keys/0` ↔ `MAX_HOSTED_ONE_TIME_KEYS` in
      `cicchetto/src/lib/e2e/keyBundle.ts`: what a device tops its bundle up
      to, since grappa refuses an upload past it whole.

  Nothing else ties the two numbers together, and a change to one side
  alone has grappa and cic refuse different things. The cic source is read
  at compile time (it is mounted into the test container,
  `scripts/_lib.sh`), the constant by an anchored match on its whole
  declaration.
  """
  use ExUnit.Case, async: true

  alias Grappa.E2eKeys
  alias Grappa.E2eKeys.DeviceList

  @wire "cicchetto/src/lib/e2e/wire.ts"
  @key_bundle "cicchetto/src/lib/e2e/keyBundle.ts"

  @wire_path Path.expand("../../../" <> @wire, __DIR__)
  @key_bundle_path Path.expand("../../../" <> @key_bundle, __DIR__)
  @external_resource @wire_path
  @external_resource @key_bundle_path
  @wire_source File.read!(@wire_path)
  @key_bundle_source File.read!(@key_bundle_path)

  test "MAX_DEVICES in wire.ts equals DeviceList.max_devices/0" do
    assert cic_integer(@wire_source, @wire, "MAX_DEVICES") == DeviceList.max_devices()
  end

  test "MAX_HOSTED_ONE_TIME_KEYS in keyBundle.ts equals E2eKeys.max_one_time_keys/0" do
    assert cic_integer(@key_bundle_source, @key_bundle, "MAX_HOSTED_ONE_TIME_KEYS") ==
             E2eKeys.max_one_time_keys()
  end

  # A constant renamed, moved, or no longer a plain integer literal flunks
  # naming the file and the constant, rather than comparing nil and failing
  # without saying what went missing.
  defp cic_integer(source, file, name) do
    case Regex.run(~r/^export const #{Regex.escape(name)} = (\d+);$/m, source) do
      [_, digits] -> String.to_integer(digits)
      nil -> flunk("no `export const #{name} = <int>;` in #{file}")
    end
  end
end
