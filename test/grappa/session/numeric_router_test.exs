defmodule Grappa.Session.NumericRouterTest do
  @moduledoc """
  Unit + property tests for `Grappa.Session.NumericRouter`.

  Tests assert ROUTING OUTCOMES (the decision tuple), not call sequences.
  The CP13 rewrite removed `last_command_window` resolution and the
  `:active` decision; the new shape is label > delegated > active-deny
  → `{:server, nil}` > param scan → `{:channel, x}` | `{:query, x}` |
  `{:server, nil}`.
  """
  use ExUnit.Case, async: true

  use ExUnitProperties

  alias Grappa.IRC.Message
  alias Grappa.Session.NumericRouter

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp msg(numeric, params) do
    %Message{command: {:numeric, numeric}, params: params}
  end

  defp msg_tagged(numeric, params, label) do
    %Message{command: {:numeric, numeric}, params: params, tags: %{"label" => label}}
  end

  defp state(opts \\ []) do
    %{
      own_nick: Keyword.get(opts, :own_nick, "vjt"),
      labels_pending: Keyword.get(opts, :labels_pending, %{})
    }
  end

  # ---------------------------------------------------------------------------
  # Param scan: channel-prefix wins
  # ---------------------------------------------------------------------------

  describe "param scan — channel-prefix → {:channel, chan}" do
    test "404 ERR_CANNOTSENDTOCHAN extracts channel from params" do
      m = msg(404, ["vjt", "#sniffo", "Cannot send to channel"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    test "482 ERR_CHANOPRIVSNEEDED extracts channel from params" do
      m = msg(482, ["vjt", "#sniffo", "You're not channel operator"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    test "367 RPL_BANLIST extracts channel even with extra params" do
      m = msg(367, ["vjt", "#sniffo", "*!*@host", "setter", "1234567890"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    test "channel & prefix is recognised" do
      m = msg(404, ["vjt", "&local", "Cannot send"])
      assert {:channel, "&local"} = NumericRouter.route(m, state())
    end

    test "channel ! prefix is recognised" do
      m = msg(404, ["vjt", "!safechan", "Cannot send"])
      assert {:channel, "!safechan"} = NumericRouter.route(m, state())
    end

    test "channel + prefix is recognised" do
      m = msg(404, ["vjt", "+modeless", "Cannot send"])
      assert {:channel, "+modeless"} = NumericRouter.route(m, state())
    end

    property "any channel-prefix in any candidate position wins over later params" do
      check all(
              numeric <- integer(400..499),
              numeric not in [421, 432, 433, 437, 461],
              chan_body <- string(:alphanumeric, min_length: 1, max_length: 20)
            ) do
        chan = "#" <> chan_body
        m = msg(numeric, ["vjt", chan, "trailing text"])
        assert {:channel, ^chan} = NumericRouter.route(m, state())
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Param scan: nick-shaped → {:query, nick}
  # ---------------------------------------------------------------------------

  describe "param scan — valid nick (non-own, no dot) → {:query, nick}" do
    test "401 ERR_NOSUCHNICK routes to query window for the nick" do
      m = msg(401, ["vjt", "someguy", "No such nick"])
      assert {:query, "someguy"} = NumericRouter.route(m, state())
    end

    test "preserves the case of the nick in the decision" do
      m = msg(401, ["vjt", "SomeGuy", "No such nick"])
      assert {:query, "SomeGuy"} = NumericRouter.route(m, state())
    end

    test "skips own-nick (case-insensitive) — falls through to {:server, nil}" do
      # 401 echoing only own-nick + trailing → no candidate → server.
      m = msg(401, ["vjt", "VJT", "No such nick"])
      assert {:server, nil} = NumericRouter.route(m, state(own_nick: "vjt"))
    end

    test "skips server hostnames (contain '.')" do
      # 999 (unknown numeric) with hostname-shaped param → not a query.
      m = msg(999, ["vjt", "irc.azzurra.chat", "some text"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Active deny list: nick-shaped tokens that are NOT destinations
  # ---------------------------------------------------------------------------

  @active_numerics [305, 306, 421, 432, 433, 437, 461]

  describe "@active_numerics deny list → {:server, nil}" do
    property "all @active_numerics route to {:server, nil} regardless of params" do
      check all(numeric <- member_of(@active_numerics)) do
        m = msg(numeric, ["vjt", "looks_like_a_nick", "trailing"])
        assert {:server, nil} = NumericRouter.route(m, state())
      end
    end

    test "433 ERR_NICKNAMEINUSE: rejected nick is NOT a query destination" do
      m = msg(433, ["vjt", "takenick", "Nickname is already in use"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "432 ERR_ERRONEUSNICKNAME: bad nick is NOT a query destination" do
      m = msg(432, ["vjt", "bad_nick", "Erroneous nickname"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "421 ERR_UNKNOWNCOMMAND: unknown verb is NOT a query destination" do
      m = msg(421, ["vjt", "BLEH", "Unknown command"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "461 ERR_NEEDMOREPARAMS: command name is NOT a query destination" do
      m = msg(461, ["vjt", "MODE", "Not enough parameters"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "305 RPL_UNAWAY routes to $server" do
      m = msg(305, ["vjt", "You are no longer marked as being away"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "306 RPL_NOWAWAY routes to $server" do
      m = msg(306, ["vjt", "You have been marked as being away"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Delegated numerics → :delegated
  # ---------------------------------------------------------------------------

  @delegated_numerics [311, 312, 313, 317, 318, 319, 352, 315, 353, 366, 321, 322, 323, 364, 365, 375, 372, 376]

  describe "delegated numerics → :delegated" do
    property "all delegated numerics return :delegated" do
      check all(numeric <- member_of(@delegated_numerics)) do
        m = msg(numeric, ["vjt", "some data"])
        assert :delegated = NumericRouter.route(m, state())
      end
    end

    test "311 RPL_WHOISUSER is delegated" do
      m = msg(311, ["vjt", "nick", "user", "host", "*", "realname"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "322 RPL_LIST is delegated" do
      m = msg(322, ["vjt", "#chan", "42", "a channel topic"])
      assert :delegated = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Labeled-response: label-based routing overrides everything else
  # ---------------------------------------------------------------------------

  describe "labeled-response override" do
    test "label override wins over channel param scan" do
      m = msg_tagged(404, ["vjt", "#other-chan", "Cannot send"], "abc123")

      state =
        state(labels_pending: %{"abc123" => %{kind: :channel, target: "#mychan"}})

      assert {:channel, "#mychan"} = NumericRouter.route(m, state)
    end

    test "label override wins over @active_numerics deny" do
      m = msg_tagged(432, ["vjt", "bad", "Erroneous nickname"], "xyz789")

      state =
        state(labels_pending: %{"xyz789" => %{kind: :query, target: "someguy"}})

      assert {:query, "someguy"} = NumericRouter.route(m, state)
    end

    test "label override can target $server explicitly" do
      m = msg_tagged(404, ["vjt", "#chan", "x"], "lbl")
      state = state(labels_pending: %{"lbl" => %{kind: :server, target: nil}})
      assert {:server, nil} = NumericRouter.route(m, state)
    end

    test "unknown label tag falls through to param-derived routing" do
      m = msg_tagged(404, ["vjt", "#sniffo", "Cannot send"], "unknown-label")

      state =
        state(labels_pending: %{"different-label" => %{kind: :channel, target: "#other"}})

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end

    test "no label tag falls through to param-derived routing" do
      m = msg(404, ["vjt", "#sniffo", "Cannot send"])

      state =
        state(labels_pending: %{"abc" => %{kind: :channel, target: "#other"}})

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end
  end

  # ---------------------------------------------------------------------------
  # Edge: short / empty params → {:server, nil}
  # ---------------------------------------------------------------------------

  describe "short param lists → {:server, nil}" do
    test "1-elem params (own-nick only) → server" do
      m = msg(999, ["vjt"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "2-elem params (own-nick + trailing) → no candidate → server" do
      m = msg(999, ["vjt", "trailing"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "empty params → server" do
      m = msg(999, [])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # severity/1
  # ---------------------------------------------------------------------------

  describe "severity/1" do
    test "4xx numerics are :error severity" do
      assert :error = NumericRouter.severity(404)
      assert :error = NumericRouter.severity(482)
      assert :error = NumericRouter.severity(433)
      assert :error = NumericRouter.severity(471)
    end

    test "5xx numerics are :error severity" do
      assert :error = NumericRouter.severity(500)
    end

    test "1xx/2xx/3xx numerics are :ok severity" do
      assert :ok = NumericRouter.severity(1)
      assert :ok = NumericRouter.severity(305)
      assert :ok = NumericRouter.severity(306)
      assert :ok = NumericRouter.severity(367)
      assert :ok = NumericRouter.severity(368)
    end
  end
end
