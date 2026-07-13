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
  alias Grappa.Session.{ISupport, Wire}

  describe "channels_changed/0" do
    test "returns the discriminator-only payload" do
      assert Wire.channels_changed() == %{kind: :channels_changed}
    end
  end

  describe "own_nick_changed/2" do
    test "carries network_id (integer) + nick (string)" do
      assert Wire.own_nick_changed(7, "vjt-grappa") == %{
               kind: :own_nick_changed,
               network_id: 7,
               nick: "vjt-grappa"
             }
    end
  end

  describe "umode_changed/2" do
    test "carries network_id (integer) + modes (string list)" do
      assert Wire.umode_changed(7, ["S", "i", "w"]) == %{
               kind: :umode_changed,
               network_id: 7,
               modes: ["S", "i", "w"]
             }
    end

    test "the payload is JSON-encodable (plain list, no leaks)" do
      payload = Wire.umode_changed(3, ["i"])
      assert {:ok, _} = Jason.encode(payload)
    end
  end

  describe "isupport_changed/2" do
    test "projects ISupport.t() to a JSON-encodable payload (MapSets → sorted lists)" do
      isupport =
        ISupport.merge_isupport(
          ["s", "CHANMODES=beI,k,l,imnpst", "PREFIX=(ohv)@%+"],
          ISupport.default()
        )

      payload = Wire.isupport_changed(7, isupport)

      assert payload.kind == :isupport_changed
      assert payload.network_id == 7
      assert payload.chanmodes_a == ["I", "b", "e"]
      assert payload.chanmodes_b == ["k"]
      assert payload.chanmodes_c == ["l"]
      assert Enum.sort(payload.chanmodes_d) == ["i", "m", "n", "p", "s", "t"]
      assert payload.prefix == %{"o" => "@", "h" => "%", "v" => "+"}
    end

    test "the payload is JSON-encodable (no MapSet leaks)" do
      payload = Wire.isupport_changed(1, ISupport.default())
      assert {:ok, _} = Jason.encode(payload)
    end
  end

  describe "topic_changed/3" do
    test "converts the EventRouter topic_entry to the wire shape (set_at: DateTime → ISO8601)" do
      {:ok, dt, 0} = DateTime.from_iso8601("2026-05-22T12:34:56Z")
      entry = %{text: "Welcome to #grappa", set_by: "vjt", set_at: dt}

      assert Wire.topic_changed("azzurra", "#grappa", entry) == %{
               kind: :topic_changed,
               network: "azzurra",
               channel: "#grappa",
               topic: %{
                 text: "Welcome to #grappa",
                 set_by: "vjt",
                 set_at: "2026-05-22T12:34:56Z"
               }
             }
    end

    test "preserves nil text + nil set_by + nil set_at (RPL_NOTOPIC / partial state)" do
      entry = %{text: nil, set_by: nil, set_at: nil}

      assert Wire.topic_changed("azzurra", "#grappa", entry) == %{
               kind: :topic_changed,
               network: "azzurra",
               channel: "#grappa",
               topic: %{text: nil, set_by: nil, set_at: nil}
             }
    end

    test "rejects malformed entries (closed shape enforced at the boundary)" do
      # `apply/3` defeats the Elixir 1.19 set-theoretic compile-time
      # type checker. The runtime FunctionClauseError is what pins
      # the boundary.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :topic_changed, ["azzurra", "#grappa", %{}])
      end

      # set_at as a raw integer (not DateTime) — Jason.Encoder would
      # silently serialize it as a number; the boundary catches it.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :topic_changed, [
          "azzurra",
          "#grappa",
          %{text: "t", set_by: "v", set_at: 1_700_000_000}
        ])
      end
    end
  end

  describe "channel_modes_changed/3" do
    test "passes the modes entry through (REV-H H4: structural copy with typed boundary)" do
      entry = %{modes: ["n", "t"], params: %{}}

      assert Wire.channel_modes_changed("azzurra", "#grappa", entry) == %{
               kind: :channel_modes_changed,
               network: "azzurra",
               channel: "#grappa",
               modes: %{modes: ["n", "t"], params: %{}}
             }
    end

    test "preserves mode-with-arg params (k=secret, l=42)" do
      entry = %{modes: ["k", "l", "n"], params: %{"k" => "secret", "l" => "42"}}

      assert Wire.channel_modes_changed("azzurra", "#grappa", entry) == %{
               kind: :channel_modes_changed,
               network: "azzurra",
               channel: "#grappa",
               modes: %{modes: ["k", "l", "n"], params: %{"k" => "secret", "l" => "42"}}
             }
    end

    test "rejects malformed entries (closed shape enforced at the boundary)" do
      # `apply/3` bypasses the Elixir 1.19 set-theoretic type checker
      # which would flag the malformed literals as a compile-time
      # type error (the typespec WORKS). The runtime FunctionClauseError
      # is what we're pinning.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :channel_modes_changed, ["azzurra", "#grappa", %{}])
      end

      # params as a list (not a map) — pre-H4 the lax map() spec
      # accepted this; tightened to %{required(String.t()) => ...}.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :channel_modes_changed, ["azzurra", "#grappa", %{modes: ["n"], params: []}])
      end
    end
  end

  describe "members_seeded/3" do
    test "emits each member through member/1 in the seeded payload" do
      members = [
        %{nick: "vjt", modes: ["@"]},
        %{nick: "alice", modes: ["+"]},
        %{nick: "bob", modes: []}
      ]

      assert Wire.members_seeded("azzurra", "#grappa", members) == %{
               kind: :members_seeded,
               network: "azzurra",
               channel: "#grappa",
               members: members
             }
    end

    test "per-member shape ≡ member/1 output (web/S4 envelope unification)" do
      members = [
        %{nick: "vjt", modes: ["@"]},
        %{nick: "alice", modes: ["+"]},
        %{nick: "bob", modes: []}
      ]

      payload = Wire.members_seeded("azzurra", "#grappa", members)
      assert payload.members == Enum.map(members, &Wire.member/1)
    end
  end

  describe "names_reply/3" do
    test "projects an explicit-/names roster through member/1 (mirrors members_seeded/3)" do
      members = [
        %{nick: "vjt", modes: ["@"]},
        %{nick: "alice", modes: ["+"]},
        %{nick: "bob", modes: []}
      ]

      assert Wire.names_reply("azzurra", "#grappa", members) == %{
               kind: :names_reply,
               network: "azzurra",
               channel: "#grappa",
               members: members
             }
    end

    test "per-member shape ≡ member/1 output — one roster contract with members_seeded" do
      members = [%{nick: "vjt", modes: ["@"]}, %{nick: "bob", modes: []}]
      payload = Wire.names_reply("azzurra", "#grappa", members)
      assert payload.members == Enum.map(members, &Wire.member/1)
    end

    test "tolerates an empty roster (366 with zero names — +secret/empty channel)" do
      assert Wire.names_reply("azzurra", "#ghost", []) == %{
               kind: :names_reply,
               network: "azzurra",
               channel: "#ghost",
               members: []
             }
    end
  end

  describe "who_reply/3 (#169)" do
    test "projects the parsed /who rows through who_user/1" do
      users = [
        %{
          nick: "alice",
          user: "au",
          host: "ah",
          server: "s1",
          modes: "H@",
          hops: 0,
          realname: "Alice",
          channel: "#grappa"
        },
        %{
          nick: "bob",
          user: "bu",
          host: "bh",
          server: "s2",
          modes: "G",
          hops: 2,
          realname: nil,
          channel: "#grappa"
        }
      ]

      assert Wire.who_reply("azzurra", "#grappa", users) == %{
               kind: :who_reply,
               network: "azzurra",
               target: "#grappa",
               users: users
             }
    end

    test "per-row shape ≡ who_user/1 output — single wire contract" do
      users = [
        %{
          nick: "alice",
          user: "au",
          host: "ah",
          server: "s",
          modes: "H",
          hops: 0,
          realname: "A",
          channel: "#g"
        }
      ]

      payload = Wire.who_reply("azzurra", "#g", users)
      assert payload.users == Enum.map(users, &Wire.who_user/1)
    end

    test "tolerates an empty roster (315 with zero matches)" do
      assert Wire.who_reply("azzurra", "nobody", []) == %{
               kind: :who_reply,
               network: "azzurra",
               target: "nobody",
               users: []
             }
    end
  end

  describe "server_reply/3 (#127)" do
    test "builds the typed :info payload with raw lines in wire order" do
      assert Wire.server_reply("azzurra", :info, ["grappa server", "Built 2026"]) == %{
               kind: :server_reply,
               network: "azzurra",
               source: :info,
               lines: ["grappa server", "Built 2026"]
             }
    end

    test "builds the :version payload (single line)" do
      assert Wire.server_reply("azzurra", :version, ["bahamut-2.2.1 irc.test"]) == %{
               kind: :server_reply,
               network: "azzurra",
               source: :version,
               lines: ["bahamut-2.2.1 irc.test"]
             }
    end

    test "builds the :motd payload and tolerates an empty line list (422 no-MOTD)" do
      assert Wire.server_reply("azzurra", :motd, []) == %{
               kind: :server_reply,
               network: "azzurra",
               source: :motd,
               lines: []
             }
    end
  end

  describe "member/1" do
    test "projects a Session.member() to the per-row wire shape" do
      assert Wire.member(%{nick: "vjt", modes: ["@"]}) == %{nick: "vjt", modes: ["@"]}
    end

    test "preserves an empty modes list (regular voice-less member)" do
      assert Wire.member(%{nick: "bob", modes: []}) == %{nick: "bob", modes: []}
    end

    test "filters extra source fields to the contract (future-drift insulation)" do
      # member/1 is load-bearing for shape changes: even if a future
      # Session.member() type acquires extra fields, the wire boundary
      # must NOT leak them. Pattern-match-then-rebuild gives us this for
      # free today; this test pins the contract so a regression that
      # adds Map.put(:account, ...) to the projection is caught.
      assert Wire.member(%{nick: "vjt", modes: ["@"], account: "leaked", host: "h.example"}) ==
               %{nick: "vjt", modes: ["@"]}
    end
  end

  describe "members_index/1" do
    test "wraps a member list in the REST envelope %{members: [...]}" do
      members = [
        %{nick: "vjt", modes: ["@"]},
        %{nick: "alice", modes: []}
      ]

      assert Wire.members_index(members) == %{
               members: [
                 %{nick: "vjt", modes: ["@"]},
                 %{nick: "alice", modes: []}
               ]
             }
    end

    test "per-member shape ≡ Channel members_seeded per-member shape (web/S4)" do
      members = [%{nick: "vjt", modes: ["@"]}, %{nick: "alice", modes: ["+"]}]

      rest = Wire.members_index(members)
      channel = Wire.members_seeded("azzurra", "#grappa", members)

      assert rest.members == channel.members
    end

    test "renders an empty list to %{members: []}" do
      assert Wire.members_index([]) == %{members: []}
    end
  end

  describe "joined/2" do
    test "carries the typed state literal" do
      assert Wire.joined("azzurra", "#grappa") == %{
               kind: :joined,
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
               kind: :window_pending,
               network: "azzurra",
               channel: "#grappa",
               state: "pending"
             }
    end
  end

  describe "window_invited/2" do
    test "carries kind=window_invited + state=invited on the user-topic shape" do
      # #78 — inbound INVITE to a not-joined channel surfaces an :invited
      # window. Same user-topic origination shape + naming convention as
      # window_pending (cic subscribes per-channel after seeing the state).
      assert Wire.window_invited("azzurra", "#grappa") == %{
               kind: :window_invited,
               network: "azzurra",
               channel: "#grappa",
               state: "invited"
             }
    end
  end

  describe "join_failed/4" do
    test "carries the failure reason + numeric" do
      assert Wire.join_failed("azzurra", "#grappa", "Cannot join (+i)", 473) == %{
               kind: :join_failed,
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
               kind: :kicked,
               network: "azzurra",
               channel: "#grappa",
               state: "kicked",
               by: "op-vjt",
               reason: "be quiet"
             }
    end

    test "tolerates nil by + nil reason from un-recorded kick meta" do
      assert Wire.kicked("azzurra", "#grappa", nil, nil) == %{
               kind: :kicked,
               network: "azzurra",
               channel: "#grappa",
               state: "kicked",
               by: nil,
               reason: nil
             }
    end
  end

  describe "away_confirmed/2" do
    test "carries the present/away state string (REV-H H3: atom→string at the wire boundary)" do
      assert Wire.away_confirmed("azzurra", :present) == %{
               kind: :away_confirmed,
               network: "azzurra",
               state: "present"
             }

      assert Wire.away_confirmed("azzurra", :away) == %{
               kind: :away_confirmed,
               network: "azzurra",
               state: "away"
             }
    end

    test "rejects unknown atoms (closed set enforced at the boundary)" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :away_confirmed, ["azzurra", :unknown])
      end
    end

    test "rejects string input (callers pass the EventRouter effect atom, not a string)" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :away_confirmed, ["azzurra", "present"])
      end
    end
  end

  describe "connection_progress/2 (#100)" do
    test "carries the connecting/connected state string (atom→string at the wire boundary)" do
      assert Wire.connection_progress("azzurra", :connecting) == %{
               kind: :connection_progress,
               network: "azzurra",
               state: "connecting"
             }

      assert Wire.connection_progress("azzurra", :connected) == %{
               kind: :connection_progress,
               network: "azzurra",
               state: "connected"
             }
    end

    test "rejects unknown atoms (closed set enforced at the boundary)" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :connection_progress, ["azzurra", :parked])
      end
    end

    test "rejects string input (callers pass the atom, not a string)" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :connection_progress, ["azzurra", "connecting"])
      end
    end
  end

  describe "mentions_bundle/5" do
    test "projects each Message.t() to {server_time, channel, sender, body, kind} per CP15-decision; kind atom→string" do
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
               kind: :mentions_bundle,
               network: "azzurra",
               away_started_at: "2026-05-08T08:00:00.000Z",
               away_ended_at: "2026-05-08T08:05:00.000Z",
               away_reason: "afk",
               messages: [
                 %{
                   server_time: 1_700_000_001,
                   channel: "#grappa",
                   sender: "alice",
                   body: "vjt: hey",
                   kind: :privmsg
                 },
                 %{
                   server_time: 1_700_000_002,
                   channel: "#grappa",
                   sender: "bob",
                   body: "vjt: pong",
                   kind: :action
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

  describe "whois_bundle/3" do
    test "projects the accum map into the wire shape with kind: injected" do
      accum = %{
        user: "alice_u",
        host: "alice.host",
        realname: "Alice Liddell",
        server: "irc.azzurra.org",
        server_info: "Azzurra Hub",
        is_operator: true,
        idle_seconds: 42,
        signon: 1_700_000_000,
        channels: ["@#italia", "+#grappa"]
      }

      payload = Wire.whois_bundle("azzurra", "alice", accum)

      assert payload == %{
               kind: :whois_bundle,
               network: "azzurra",
               target: "alice",
               user: "alice_u",
               host: "alice.host",
               realname: "Alice Liddell",
               server: "irc.azzurra.org",
               server_info: "Azzurra Hub",
               is_operator: true,
               idle_seconds: 42,
               signon: 1_700_000_000,
               channels: ["@#italia", "+#grappa"],
               # P-0a — 11 new WHOIS-leg flags / strings (default false / nil
               # when the corresponding numeric did not fire).
               using_ssl: false,
               is_registered: false,
               is_admin: false,
               is_services_admin: false,
               is_helper: false,
               is_chanop: false,
               is_agent: false,
               is_java: false,
               umodes: nil,
               away_message: nil,
               actually_host: nil,
               actually_ip: nil
             }
    end

    test "tolerates an empty accum (no numerics fired before 318) — every field nil; is_operator false" do
      payload = Wire.whois_bundle("azzurra", "ghost", %{})

      assert payload == %{
               kind: :whois_bundle,
               network: "azzurra",
               target: "ghost",
               user: nil,
               host: nil,
               realname: nil,
               server: nil,
               server_info: nil,
               is_operator: false,
               idle_seconds: nil,
               signon: nil,
               channels: nil,
               # P-0a defaults
               using_ssl: false,
               is_registered: false,
               is_admin: false,
               is_services_admin: false,
               is_helper: false,
               is_chanop: false,
               is_agent: false,
               is_java: false,
               umodes: nil,
               away_message: nil,
               actually_host: nil,
               actually_ip: nil
             }
    end
  end

  describe "peer_away/3" do
    test "projects (network, peer, message) into the wire shape with kind: injected" do
      payload = Wire.peer_away("azzurra", "alice", "Gone fishing")

      assert payload == %{
               kind: :peer_away,
               network: "azzurra",
               peer: "alice",
               message: "Gone fishing"
             }
    end

    test "tolerates an empty message string (some servers send 301 with empty trailing)" do
      payload = Wire.peer_away("azzurra", "alice", "")
      assert payload.kind == :peer_away
      assert payload.message == ""
    end
  end

  describe "invite_ack/3" do
    test "projects (network, channel, peer) into the wire shape with kind: injected" do
      payload = Wire.invite_ack("azzurra", "#italia", "alice")

      assert payload == %{
               kind: :invite_ack,
               network: "azzurra",
               channel: "#italia",
               peer: "alice"
             }
    end
  end

  describe "lusers_bundle/2" do
    test "projects accum integers into the wire shape, all 12 numeric fields present" do
      accum = %{
        total_users: 1234,
        invisible: 56,
        servers: 3,
        operators: 7,
        unknown_connections: 2,
        channels_formed: 89,
        local_clients: 100,
        local_servers: 1,
        current_local: 100,
        max_local: 200,
        current_global: 1234,
        max_global: 5000
      }

      payload = Wire.lusers_bundle("azzurra", accum)

      assert payload == %{
               kind: :lusers_bundle,
               network: "azzurra",
               total_users: 1234,
               invisible: 56,
               servers: 3,
               operators: 7,
               unknown_connections: 2,
               channels_formed: 89,
               local_clients: 100,
               local_servers: 1,
               current_local: 100,
               max_local: 200,
               current_global: 1234,
               max_global: 5000
             }
    end

    test "missing accum keys project to nil (graceful degradation for partial bundles)" do
      payload = Wire.lusers_bundle("net", %{total_users: 42})

      assert payload.kind == :lusers_bundle
      assert payload.total_users == 42
      assert payload.invisible == nil
      assert payload.unknown_connections == nil
      assert payload.max_global == nil
    end
  end

  describe "whowas_bundle/3" do
    test "projects MOST-RECENT entry (head of reversed list) into typed historical fields" do
      # EventRouter stores entries reversed (head = most recent 314).
      # Wire builder reads `hd(entries)` for the projection.
      accum = %{
        target_display: "Alice",
        entries: [
          %{
            user: "alice_u",
            host: "alice.host",
            realname: "Alice Liddell",
            server: "irc.test.org",
            logoff_time: "Mon May 13 12:34:56 2026"
          },
          %{user: "old_u", host: "old.host", realname: "Old Alice"}
        ]
      }

      payload = Wire.whowas_bundle("azzurra", "Alice", accum)

      assert payload == %{
               kind: :whowas_bundle,
               network: "azzurra",
               target: "Alice",
               user: "alice_u",
               host: "alice.host",
               realname: "Alice Liddell",
               server: "irc.test.org",
               logoff_time: "Mon May 13 12:34:56 2026",
               not_found: false
             }
    end

    test "not_found: true projects nil for all historical fields (406 ERR_WASNOSUCHNICK case)" do
      payload = Wire.whowas_bundle("net", "ghost", %{not_found: true})

      assert payload == %{
               kind: :whowas_bundle,
               network: "net",
               target: "ghost",
               user: nil,
               host: nil,
               realname: nil,
               server: nil,
               logoff_time: nil,
               not_found: true
             }
    end

    test "empty entries with not_found absent defaults to not_found: false + nil fields" do
      payload = Wire.whowas_bundle("net", "alice", %{entries: []})

      assert payload.kind == :whowas_bundle
      assert payload.target == "alice"
      assert payload.not_found == false
      assert payload.user == nil
      assert payload.logoff_time == nil
    end
  end

  describe "kind: discriminator atom contract" do
    test "every Wire fn output carries kind: as an atom literal (Jason serializes to string at wire boundary)" do
      payloads = [
        Wire.channels_changed(),
        Wire.own_nick_changed(1, "n"),
        Wire.topic_changed("net", "#c", %{text: nil, set_by: nil, set_at: nil}),
        Wire.channel_modes_changed("net", "#c", %{modes: [], params: %{}}),
        Wire.members_seeded("net", "#c", []),
        Wire.joined("net", "#c"),
        Wire.window_pending("net", "#c"),
        Wire.join_failed("net", "#c", "r", 473),
        Wire.kicked("net", "#c", "by", "r"),
        Wire.away_confirmed("net", :present),
        Wire.mentions_bundle("net", "from", "to", nil, []),
        Wire.whois_bundle("net", "alice", %{}),
        Wire.peer_away("net", "alice", "Gone fishing"),
        Wire.invite_ack("net", "#italia", "alice"),
        Wire.lusers_bundle("net", %{}),
        Wire.whowas_bundle("net", "alice", %{}),
        Wire.whowas_bundle("net", "ghost", %{not_found: true}),
        Wire.connection_progress("net", :connecting),
        Wire.connection_progress("net", :connected)
      ]

      for p <- payloads do
        assert is_atom(p.kind) and p.kind not in [nil, true, false],
               "expected atom literal kind, got #{inspect(p.kind)} in #{inspect(p)}"
      end
    end
  end
end
