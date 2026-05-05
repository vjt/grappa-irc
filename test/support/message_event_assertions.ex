defmodule Grappa.MessageEventAssertions do
  @moduledoc """
  Test assertions for the canonical PubSub broadcast event payload
  `%{kind: :message, message: wire_shape}` produced by
  `Grappa.Scrollback.Wire.message_payload/1` and broadcast via
  `Grappa.PubSub.broadcast_event/2`.

  Test processes that subscribe with `Phoenix.PubSub.subscribe(Grappa.PubSub,
  topic)` receive the wrapping `%Phoenix.Socket.Broadcast{event: "event",
  payload: %{kind: :message, message: wire}}` struct (because
  `Grappa.PubSub.broadcast_event/2` goes through the framework-native
  `Phoenix.Channel.Server.broadcast/4` dispatcher, which sends the
  `Broadcast` struct to plain subscribers and uses the fastlane for
  channel subscribers — see BUG 6 for why we cannot use the raw
  `Phoenix.PubSub.broadcast/3` envelope anymore).

  Centralised so that tests assert OUTCOMES (sender, body, channel)
  rather than re-inlining the full wire-shape map. A regression in
  the wire contract is caught at the producer (Scrollback.Wire) and
  in the wire test (`Grappa.Scrollback.WireTest`); broadcaster tests
  only check the per-test domain expectations.

  Architecture review finding A17.
  """

  import ExUnit.Assertions

  @doc """
  Receives a `%Phoenix.Socket.Broadcast{event: "event", payload:
  %{kind: :message, message: wire}}` struct from the test process
  mailbox within `timeout` ms, asserts each `expected_attrs`
  key/value matches the corresponding field of the wire payload,
  and returns the wire map for further inspection (e.g. `assert
  is_integer(msg.id)`).

  ## Example

      msg = assert_message_event(
        sender: "alice",
        body: "hello",
        channel: "#sniffo",
        network_id: "test",
        kind: :privmsg,
        meta: %{}
      )

      assert is_integer(msg.id)
      assert is_integer(msg.server_time)
  """
  defmacro assert_message_event(expected_attrs, timeout \\ 1_000) do
    quote do
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :message, message: msg}
                     },
                     unquote(timeout)

      Enum.each(unquote(expected_attrs), fn {key, expected} ->
        actual = Map.fetch!(msg, key)

        assert actual == expected,
               "expected message.#{key} to equal #{inspect(expected)}, got #{inspect(actual)}"
      end)

      msg
    end
  end
end
