defmodule Grappa.Session.WireTest do
  @moduledoc """
  Tests for `Grappa.Session.Wire` — single source of truth for the
  9 event payloads emitted on Phoenix.PubSub from
  `Grappa.Session.Server` (apply_effects arms +
  `maybe_broadcast_*` helpers + cold-WS-subscribe snapshot path
  in `window_state_payload/3`).

  CRITICAL invariants (per CP15 B7 + 2026-05-08 architecture review
  Theme 1):

    * Event-time payload (apply_effects arm) and snapshot payload
      (window_state_payload) MUST be byte-identical for the same
      window state. Today this is enforced by code review; this test
      module promotes the byte-identicality to a function-level
      contract.
    * `kind:` is ALWAYS a string literal at the wire boundary.
      `Message.kind()` (Ecto.Enum atom) is converted at the Wire fn
      that touches it (`mentions_bundle/5`).
  """
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Message
  alias Grappa.Session.Wire

  describe "channels_changed/0" do
    test "returns the discriminator-only payload" do
      assert Wire.channels_changed() == %{kind: "channels_changed"}
    end
  end

  describe "own_nick_changed/2" do
    test "carries network_id (integer) + nick (string)" do
      assert Wire.own_nick_changed(7, "vjt-grappa") == %{
               kind: "own_nick_changed",
               network_id: 7,
               nick: "vjt-grappa"
             }
    end
  end

  describe "topic_changed/3" do
    test "passes the topic entry through unchanged" do
      entry = %{topic: "Welcome to #grappa", set_by: "vjt", set_at: 1_700_000_000}

      assert Wire.topic_changed("azzurra", "#grappa", entry) == %{
               kind: "topic_changed",
               network: "azzurra",
               channel: "#grappa",
               topic: entry
             }
    end
  end

  describe "channel_modes_changed/3" do
    test "passes the modes entry through unchanged" do
      entry = %{modes: "+nt", params: []}

      assert Wire.channel_modes_changed("azzurra", "#grappa", entry) == %{
               kind: "channel_modes_changed",
               network: "azzurra",
               channel: "#grappa",
               modes: entry
             }
    end
  end

  describe "members_seeded/3" do
    test "passes the pre-sorted members list through unchanged" do
      members = [
        %{nick: "vjt", modes: ["@"]},
        %{nick: "alice", modes: ["+"]},
        %{nick: "bob", modes: []}
      ]

      assert Wire.members_seeded("azzurra", "#grappa", members) == %{
               kind: "members_seeded",
               network: "azzurra",
               channel: "#grappa",
               members: members
             }
    end
  end

  describe "joined/2" do
    test "carries the typed state literal" do
      assert Wire.joined("azzurra", "#grappa") == %{
               kind: "joined",
               network: "azzurra",
               channel: "#grappa",
               state: "joined"
             }
    end
  end

  describe "window_pending/2" do
    test "carries kind=window_pending + state=pending on the user-topic shape" do
      # CP17 — `:pending` origination moved to the server. Broadcast on
      # `Topic.user(...)` (NOT per-channel — chicken-and-egg: cic only
      # subscribes to per-channel after seeing :pending). Naming
      # convention `window_pending` (not `pending`) mirrors the existing
      # `connection_state_changed` user-topic verb: state-change events
      # on the user-topic carry a window-namespace prefix to avoid
      # collision with channel-namespace verbs (`joined` etc.).
      assert Wire.window_pending("azzurra", "#grappa") == %{
               kind: "window_pending",
               network: "azzurra",
               channel: "#grappa",
               state: "pending"
             }
    end
  end

  describe "join_failed/4" do
    test "carries the failure reason + numeric" do
      assert Wire.join_failed("azzurra", "#grappa", "Cannot join (+i)", 473) == %{
               kind: "join_failed",
               network: "azzurra",
               channel: "#grappa",
               state: "failed",
               reason: "Cannot join (+i)",
               numeric: 473
             }
    end
  end

  describe "kicked/4" do
    test "carries the kicker + reason" do
      assert Wire.kicked("azzurra", "#grappa", "op-vjt", "be quiet") == %{
               kind: "kicked",
               network: "azzurra",
               channel: "#grappa",
               state: "kicked",
               by: "op-vjt",
               reason: "be quiet"
             }
    end

    test "tolerates nil by + nil reason from un-recorded kick meta" do
      assert Wire.kicked("azzurra", "#grappa", nil, nil) == %{
               kind: "kicked",
               network: "azzurra",
               channel: "#grappa",
               state: "kicked",
               by: nil,
               reason: nil
             }
    end
  end

  describe "away_confirmed/2" do
    test "carries the present/away state string" do
      assert Wire.away_confirmed("azzurra", "present") == %{
               kind: "away_confirmed",
               network: "azzurra",
               state: "present"
             }

      assert Wire.away_confirmed("azzurra", "away") == %{
               kind: "away_confirmed",
               network: "azzurra",
               state: "away"
             }
    end
  end

  describe "mentions_bundle/5" do
    test "projects each Message.t() to {server_time, channel, sender_nick, body, kind} per CP15-decision; kind atom→string" do
      m1 = %Message{
        server_time: 1_700_000_001,
        channel: "#grappa",
        sender: "alice",
        body: "vjt: hey",
        kind: :privmsg
      }

      m2 = %Message{
        server_time: 1_700_000_002,
        channel: "#grappa",
        sender: "bob",
        body: "vjt: pong",
        kind: :action
      }

      payload =
        Wire.mentions_bundle(
          "azzurra",
          "2026-05-08T08:00:00.000Z",
          "2026-05-08T08:05:00.000Z",
          "afk",
          [m1, m2]
        )

      assert payload == %{
               kind: "mentions_bundle",
               network: "azzurra",
               away_started_at: "2026-05-08T08:00:00.000Z",
               away_ended_at: "2026-05-08T08:05:00.000Z",
               away_reason: "afk",
               messages: [
                 %{
                   server_time: 1_700_000_001,
                   channel: "#grappa",
                   sender_nick: "alice",
                   body: "vjt: hey",
                   kind: "privmsg"
                 },
                 %{
                   server_time: 1_700_000_002,
                   channel: "#grappa",
                   sender_nick: "bob",
                   body: "vjt: pong",
                   kind: "action"
                 }
               ]
             }
    end

    test "tolerates nil away_reason" do
      payload =
        Wire.mentions_bundle("azzurra", "2026-05-08T08:00:00.000Z", "2026-05-08T08:05:00.000Z", nil, [])

      assert payload.away_reason == nil
      assert payload.messages == []
    end
  end

  describe "kind: discriminator string contract" do
    test "every Wire fn output carries kind: as a String.t()" do
      payloads = [
        Wire.channels_changed(),
        Wire.own_nick_changed(1, "n"),
        Wire.topic_changed("net", "#c", %{}),
        Wire.channel_modes_changed("net", "#c", %{}),
        Wire.members_seeded("net", "#c", []),
        Wire.joined("net", "#c"),
        Wire.window_pending("net", "#c"),
        Wire.join_failed("net", "#c", "r", 473),
        Wire.kicked("net", "#c", "by", "r"),
        Wire.away_confirmed("net", "present"),
        Wire.mentions_bundle("net", "from", "to", nil, [])
      ]

      for p <- payloads do
        assert is_binary(p.kind), "expected string kind, got #{inspect(p.kind)} in #{inspect(p)}"
      end
    end
  end
end
