defmodule Grappa.Session.NumericRouterTest do
  @moduledoc """
  Unit + property tests for `Grappa.Session.NumericRouter`.

  Tests assert ROUTING OUTCOMES (the decision tuple), not call sequences.
  Property tests enumerate numeric class membership; unit tests verify
  param extraction + query-window fallback logic.
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

  defp state_with_query(nicks) when is_list(nicks) do
    %{open_query_nicks: MapSet.new(nicks)}
  end

  defp state_no_query, do: %{open_query_nicks: MapSet.new()}

  defp state_with_last_window(kind, target) do
    %{
      open_query_nicks: MapSet.new(),
      last_command_window: %{kind: kind, target: target},
      labels_pending: %{}
    }
  end

  defp state_with_label(label, kind, target) do
    %{
      open_query_nicks: MapSet.new(),
      last_command_window: nil,
      labels_pending: %{label => %{kind: kind, target: target}}
    }
  end

  # ---------------------------------------------------------------------------
  # S4.1 — channel-param numerics → :channel
  # ---------------------------------------------------------------------------

  @channel_param_numerics [404, 442, 471, 472, 473, 474, 475, 477, 478, 482, 367, 368]

  describe "channel-param numerics → {:channel, chan}" do
    property "all channel-param numerics with a channel param route to {:channel, chan}" do
      check all(
              numeric <- member_of(@channel_param_numerics),
              chan <- string(:ascii, min_length: 2),
              # channel names start with # & etc. — we use a simple valid form
              chan = "#" <> String.replace(chan, ~r/[#\s\x00\r\n,]/, "a"),
              String.length(chan) > 1
            ) do
        m = msg(numeric, ["own_nick", chan, "some trailing"])
        assert {:channel, ^chan} = NumericRouter.route(m, state_no_query())
      end
    end

    test "404 ERR_CANNOTSENDTOCHAN extracts channel from params" do
      m = msg(404, ["own", "#sniffo", "Cannot send to channel"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state_no_query())
    end

    test "482 ERR_CHANOPRIVSNEEDED extracts channel from params" do
      m = msg(482, ["own", "#sniffo", "You're not channel operator"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state_no_query())
    end

    test "367 RPL_BANLIST extracts channel from params" do
      m = msg(367, ["own", "#sniffo", "*!*@host", "setter", "1234567890"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state_no_query())
    end

    test "368 RPL_ENDOFBANLIST extracts channel from params" do
      m = msg(368, ["own", "#sniffo", "End of channel ban list"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state_no_query())
    end

    test "471 ERR_CHANNELISFULL extracts channel" do
      m = msg(471, ["own", "#full", "Cannot join channel (+l)"])
      assert {:channel, "#full"} = NumericRouter.route(m, state_no_query())
    end
  end

  # ---------------------------------------------------------------------------
  # S4.1 — nick-param numerics → :query or :active
  # ---------------------------------------------------------------------------

  describe "nick-param numerics → {:query, nick} or {:active, nil}" do
    test "401 ERR_NOSUCHNICK routes to query window when open" do
      m = msg(401, ["own", "someguy", "No such nick"])
      state = state_with_query(["someguy"])
      assert {:query, "someguy"} = NumericRouter.route(m, state)
    end

    test "401 ERR_NOSUCHNICK routes to :active when no query window" do
      m = msg(401, ["own", "someguy", "No such nick"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end

    test "405 ERR_TOOMANYCHANNELS routes to :active (no nick param)" do
      # 405 has a channel in param 1 — treated as active since channel not joined
      m = msg(405, ["own", "#toomanychans", "You have joined too many channels"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end

    test "nick comparison for query lookup is case-insensitive" do
      m = msg(401, ["own", "SOMEGUY", "No such nick"])
      state = state_with_query(["someguy"])
      assert {:query, "SOMEGUY"} = NumericRouter.route(m, state)
    end

    property "401 routes to query when nick matches (case-insensitive)" do
      check all(nick <- string(:ascii, min_length: 1, max_length: 20)) do
        nick = nick |> String.replace(~r/[\s\x00\r\n]/, "a") |> then(fn n -> if n == "", do: "a", else: n end)
        m = msg(401, ["own", nick, "No such nick"])
        state = state_with_query([String.downcase(nick)])
        assert {:query, ^nick} = NumericRouter.route(m, state)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # S4.1 — param-less numerics → :active
  # ---------------------------------------------------------------------------

  @active_numerics [432, 433, 437, 421, 461, 305, 306]

  describe "param-less / no-useful-param numerics → {:active, nil}" do
    property "all param-less numerics route to {:active, nil}" do
      check all(numeric <- member_of(@active_numerics)) do
        m = msg(numeric, ["own", "some trailing message"])
        assert {:active, nil} = NumericRouter.route(m, state_no_query())
      end
    end

    test "432 ERR_ERRONEUSNICKNAME routes to :active" do
      m = msg(432, ["own", "bad_nick", "Erroneous nickname"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end

    test "433 ERR_NICKNAMEINUSE routes to :active" do
      m = msg(433, ["own", "takenick", "Nickname is already in use"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end

    test "305 RPL_UNAWAY routes to :active" do
      m = msg(305, ["own", "You are no longer marked as being away"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end

    test "306 RPL_NOWAWAY routes to :active" do
      m = msg(306, ["own", "You have been marked as being away"])
      assert {:active, nil} = NumericRouter.route(m, state_no_query())
    end
  end

  # ---------------------------------------------------------------------------
  # S4.1 — delegated numerics → :delegated
  # ---------------------------------------------------------------------------

  @delegated_numerics [311, 312, 313, 317, 318, 319, 352, 315, 353, 366, 321, 322, 323, 364, 365, 375, 372, 376]

  describe "delegated numerics → :delegated" do
    property "all delegated numerics return :delegated" do
      check all(numeric <- member_of(@delegated_numerics)) do
        m = msg(numeric, ["own", "some data"])
        assert :delegated = NumericRouter.route(m, state_no_query())
      end
    end

    test "311 RPL_WHOISUSER is delegated" do
      m = msg(311, ["own", "nick", "user", "host", "*", "realname"])
      assert :delegated = NumericRouter.route(m, state_no_query())
    end

    test "322 RPL_LIST is delegated" do
      m = msg(322, ["own", "#chan", "42", "a channel topic"])
      assert :delegated = NumericRouter.route(m, state_no_query())
    end
  end

  # ---------------------------------------------------------------------------
  # S4.2 — labeled-response: label-based routing overrides param-derived
  # ---------------------------------------------------------------------------

  describe "labeled-response override" do
    test "label in pending labels overrides param-derived channel routing" do
      # Even though 404 would normally extract #chan from params,
      # a label echoed back routes to the labeled origin window
      m = msg_tagged(404, ["own", "#other-chan", "Cannot send"], "abc123")
      state = state_with_label("abc123", :channel, "#mychan")
      assert {:channel, "#mychan"} = NumericRouter.route(m, state)
    end

    test "label in pending labels overrides :active routing" do
      m = msg_tagged(432, ["own", "bad", "Erroneous nickname"], "xyz789")
      state = state_with_label("xyz789", :query, "someguy")
      assert {:query, "someguy"} = NumericRouter.route(m, state)
    end

    test "unknown label falls through to param-derived routing" do
      m = msg_tagged(404, ["own", "#sniffo", "Cannot send"], "unknown-label")

      state = %{
        open_query_nicks: MapSet.new(),
        last_command_window: nil,
        labels_pending: %{"different-label" => %{kind: :channel, target: "#other"}}
      }

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end

    test "no label tag falls through to param-derived routing" do
      m = msg(404, ["own", "#sniffo", "Cannot send"])

      state = %{
        open_query_nicks: MapSet.new(),
        last_command_window: nil,
        labels_pending: %{"abc" => %{kind: :channel, target: "#other"}}
      }

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end
  end

  # ---------------------------------------------------------------------------
  # S4.3 — last_command_window fallback for :active resolution
  # ---------------------------------------------------------------------------

  describe "last_command_window fallback" do
    test ":active routes to last_command_window when set" do
      m = msg(432, ["own", "badnick", "Erroneous nickname"])
      state = state_with_last_window(:channel, "#sniffo")
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end

    test ":active routes to {:active, nil} when last_command_window is nil" do
      m = msg(432, ["own", "badnick", "Erroneous nickname"])

      state = %{
        open_query_nicks: MapSet.new(),
        last_command_window: nil,
        labels_pending: %{}
      }

      assert {:active, nil} = NumericRouter.route(m, state)
    end

    test "last_command_window for query kind" do
      m = msg(421, ["own", "UNKNOWNCMD", "Unknown command"])
      state = state_with_last_window(:query, "someguy")
      assert {:query, "someguy"} = NumericRouter.route(m, state)
    end
  end

  # ---------------------------------------------------------------------------
  # severity/2
  # ---------------------------------------------------------------------------

  describe "severity/1" do
    test "4xx numerics are :error severity" do
      assert :error = NumericRouter.severity(404)
      assert :error = NumericRouter.severity(482)
      assert :error = NumericRouter.severity(433)
      assert :error = NumericRouter.severity(471)
    end

    test "2xx numerics are :ok severity" do
      assert :ok = NumericRouter.severity(305)
      assert :ok = NumericRouter.severity(306)
    end

    test "3xx numerics are :ok severity" do
      assert :ok = NumericRouter.severity(367)
      assert :ok = NumericRouter.severity(368)
    end
  end
end
