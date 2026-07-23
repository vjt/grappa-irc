defmodule Grappa.WindowCounts.WireTest do
  @moduledoc """
  Wire shape for the `window_counts` push event (#267). Plain
  JSON-encodable map; `kind:` string discriminator; `severity` kept as
  the closed atom so `mix grappa.gen_wire_types` pins the literal TS
  union (same precedent as `Scrollback.Wire`'s `kind`).
  """
  use ExUnit.Case, async: true

  alias Grappa.WindowCounts.Wire

  test "window_counts_payload builds the typed event, severity as atom" do
    snapshot = %{messages: 3, mentions: 1, events: 2, severity: :mention}

    assert Wire.window_counts_payload("#chan", snapshot) == %{
             kind: :window_counts,
             channel: "#chan",
             messages: 3,
             mentions: 1,
             events: 2,
             severity: :mention
           }
  end

  test "payload is JSON-encodable with severity stringified" do
    payload = Wire.window_counts_payload("#chan", %{messages: 0, mentions: 0, events: 0, severity: :none})

    decoded = payload |> Jason.encode!() |> Jason.decode!()

    assert decoded == %{
             "kind" => "window_counts",
             "channel" => "#chan",
             "messages" => 0,
             "mentions" => 0,
             "events" => 0,
             "severity" => "none"
           }
  end

  test "payload carries no struct (fastlane-safe)" do
    payload = Wire.window_counts_payload("#chan", %{messages: 1, mentions: 0, events: 0, severity: :message})
    refute is_struct(payload)
  end
end
