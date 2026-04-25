defmodule Grappa.MessageEventAssertions do
  @moduledoc """
  Test assertions for the canonical PubSub broadcast event tuple
  `{:event, %{kind: :message, message: wire_shape}}` produced by
  `Grappa.Scrollback.Wire.message_event/1`.

  Centralised so that tests assert OUTCOMES (sender, body, channel)
  rather than re-inlining the full wire-shape map. A regression in
  the wire contract is caught at the producer (Scrollback.Wire) and
  in the wire test (`Grappa.Scrollback.WireTest`); broadcaster tests
  only check the per-test domain expectations.

  Architecture review finding A17.
  """

  import ExUnit.Assertions

  @doc """
  Receives a `{:event, %{kind: :message, message: wire}}` tuple from
  the test process mailbox within `timeout` ms, asserts each
  `expected_attrs` key/value matches the corresponding field of the
  wire payload, and returns the wire map for further inspection
  (e.g. `assert is_integer(msg.id)`).

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
      assert_receive {:event, %{kind: :message, message: msg}}, unquote(timeout)

      Enum.each(unquote(expected_attrs), fn {key, expected} ->
        actual = Map.fetch!(msg, key)

        assert actual == expected,
               "expected message.#{key} to equal #{inspect(expected)}, got #{inspect(actual)}"
      end)

      msg
    end
  end
end
