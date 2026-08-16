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

  alias Grappa.RelayFrameHelpers
  alias Grappa.Scrollback.Message

  alias Grappa.Session.{
    ISupport,
    LinksAccum,
    ListModeAccum,
    LusersAccum,
    WhoisAccum,
    WhowasAccum,
    Wire
  }

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

  describe "supported_umodes_changed/2 (#249)" do
    test "carries network_id (integer) + modes (string list)" do
      assert Wire.supported_umodes_changed(7, ["i", "o", "w"]) == %{
               kind: :supported_umodes_changed,
               network_id: 7,
               modes: ["i", "o", "w"]
             }
    end

    test "the payload is JSON-encodable (plain list, no leaks)" do
      payload = Wire.supported_umodes_changed(3, ["i", "w"])
      assert {:ok, _} = Jason.encode(payload)
    end
  end

  describe "isupport_changed/3" do
    test "projects ISupport.t() to a JSON-encodable payload (MapSets → sorted lists)" do
      isupport =
        ISupport.merge_isupport(
          ["s", "CHANMODES=beI,k,l,imnpst", "PREFIX=(ohv)@%+"],
          ISupport.default()
        )

      payload = Wire.isupport_changed(7, isupport, 512)

      assert payload.kind == :isupport_changed
      assert payload.network_id == 7
      assert payload.chanmodes_a == ["I", "b", "e"]
      assert payload.chanmodes_b == ["k"]
      assert payload.chanmodes_c == ["l"]
      assert Enum.sort(payload.chanmodes_d) == ["i", "m", "n", "p", "s", "t"]
      assert payload.prefix == %{"o" => "@", "h" => "%", "v" => "+"}
    end

    # #1251 — the queryable set is PUBLISHED, not left for the client to
    # derive: it is `chanmodes_a` minus the letters grappa knows no reply
    # numerics for. The difference between the two lists is the quiet
    # degradation a client must be able to see.
    test "publishes list_modes_queryable — advertised type-A minus the unknown letters" do
      isupport =
        ISupport.merge_isupport(["CHANMODES=bzX,k,l,imnpst"], ISupport.default())

      payload = Wire.isupport_changed(7, isupport, 512)

      assert payload.chanmodes_a == ["X", "b", "z"]
      assert payload.list_modes_queryable == ["b", "z"]
    end

    # #1255 — the per-network facts the client used to open-code. The point
    # of the payload is that a network's REAL values reach cic, so the test
    # advertises values that differ from the seed in every field.
    test "publishes the widened per-network facts a client used to guess" do
      isupport =
        ISupport.merge_isupport(
          [
            "s",
            "CHANTYPES=#&",
            "CASEMAPPING=rfc1459",
            "MAXLIST=beI:100",
            "NICKLEN=30",
            "CHANNELLEN=200",
            "TOPICLEN=307"
          ],
          ISupport.default()
        )

      payload = Wire.isupport_changed(7, isupport, 512)

      assert payload.chantypes == ["#", "&"]
      assert payload.casemapping == :rfc1459
      assert payload.maxlist == %{"b" => 100, "e" => 100, "I" => 100}
      assert payload.nicklen == 30
      assert payload.channellen == 200
      assert payload.topiclen == 307
    end

    test "publishes the seed, and absent limits as nil, for a 005-less session" do
      # A network that advertises nothing must leave the client behaving as
      # it did before the widening: the RFC sigils, the ASCII fold, and NO
      # caps — `nil` is "do not enforce", not "zero".
      payload = Wire.isupport_changed(7, ISupport.default(), 512)

      assert payload.chantypes == ISupport.default_chantypes()
      assert payload.casemapping == ISupport.default_casemapping()
      assert payload.maxlist == %{}
      assert payload.nicklen == nil
      assert payload.channellen == nil
      assert payload.topiclen == nil
    end

    # The builder reaches a LIVE session state, and a plain hot reload does
    # not rewrite process state — so a table seeded before #1255 arrives
    # here without the new keys. It must publish the seed, not crash the
    # PubSub fan-out with a KeyError. Same guarantee the #216/#247/#537
    # accessors carry, asserted at the wire because THIS is the caller that
    # meets the stale table first.
    test "a capability table predating the widening still builds a payload" do
      pre_1255 =
        Map.drop(ISupport.default(), [
          :chantypes,
          :maxlist,
          :nicklen,
          :channellen,
          :topiclen,
          :raw
        ])

      payload = Wire.isupport_changed(7, pre_1255, 512)

      assert payload.chantypes == ISupport.default_chantypes()
      assert payload.maxlist == %{}
      assert payload.nicklen == nil
      assert {:ok, _} = Jason.encode(payload)
    end

    # The verbatim token archive is a Phase 6 listener-facade input. On this
    # wire it would be IRC protocol re-entering the web client through the
    # window (design principle #1), so it must never appear — including via
    # a lazy `Map.merge` of the whole table into the payload.
    test "does NOT publish the raw token archive" do
      isupport =
        ISupport.merge_isupport(
          ["s", "NETWORK=Azzurra", "TARGMAX=PRIVMSG:4", "SAFELIST"],
          ISupport.default()
        )

      payload = Wire.isupport_changed(7, isupport, 512)

      refute Map.has_key?(payload, :raw)
      refute payload |> Jason.encode!() |> String.contains?("Azzurra")
    end

    # #1108 — the builder takes LINELEN and publishes the BUDGET, and the
    # number is checked the way a CLIENT will spend it: subtract the target's
    # bytes, fill a body with that many, and the worst-case relayed frame
    # (#246 ceilings, `Grappa.RelayFrameHelpers`) must come out EXACTLY at
    # LINELEN. The oracle is the wire, not a second copy of the framing
    # arithmetic — an expected value re-derived by hand would only check that
    # the same sum can be written twice.
    test "publishes a budget a client can spend to the last byte of the frame" do
      for {linelen, target} <- [{512, "#sniffo"}, {1024, "#a"}, {512, "#café"}] do
        base = Wire.isupport_changed(7, ISupport.default(), linelen).frame_budget_base

        RelayFrameHelpers.assert_budget_fills_the_frame(
          base - byte_size(target),
          target,
          linelen
        )
      end
    end

    test "the payload is JSON-encodable (no MapSet leaks)" do
      payload = Wire.isupport_changed(1, ISupport.default(), 512)
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

    test "builds the #992 :admin payload (259 RPL_ADMINEMAIL drain)" do
      assert Wire.server_reply("azzurra", :admin, ["testnet admin", "root@irc.test"]) == %{
               kind: :server_reply,
               network: "azzurra",
               source: :admin,
               lines: ["testnet admin", "root@irc.test"]
             }
    end

    # The class guard, not another example. #992 added :admin to the type
    # union but not to the separate list that guarded the builder, and the
    # divergence was invisible until a live 259 crashed the Session.Server.
    # Enumerating the SSOT means the NEXT source cannot land half-wired.
    test "accepts every source in the closed set — no arm left unguarded" do
      for source <- Wire.server_reply_sources() do
        assert %{kind: :server_reply, source: ^source} =
                 Wire.server_reply("azzurra", source, ["line"])
      end
    end

    test "rejects an atom outside the closed set" do
      assert_raise FunctionClauseError, fn -> Wire.server_reply("azzurra", :links, ["line"]) end
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
               state: :joined
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
               state: :pending
             }
    end
  end

  describe "window_invited/3" do
    test "carries kind=window_invited + state=invited + inviter on the user-topic shape" do
      # #78 — inbound INVITE to a not-joined channel surfaces an :invited
      # window. Same user-topic origination shape + naming convention as
      # window_pending (cic subscribes per-channel after seeing the state).
      #
      # #902 — `inviter` is the nick cic's replacement surface (a banner
      # reading "<nick> is inviting you to #chan") renders. Additive field:
      # no protocol bump, and asserting the WHOLE map means a silent drop of
      # it fails here.
      assert Wire.window_invited("azzurra", "#grappa", "vjt") == %{
               kind: :window_invited,
               network: "azzurra",
               channel: "#grappa",
               state: :invited,
               inviter: "vjt"
             }
    end
  end

  describe "window_invite_declined/2" do
    test "carries kind + network + channel and NO state field (#976)" do
      # #976 — the operator refused the invite. Whole-map equality, and the
      # absent `state` is the assertion with teeth: every sibling window
      # payload names a state, this one deliberately does not, because a
      # declined invite lands in NO window state. Adding `state: :declined`
      # "for symmetry" would mint a seventh state that cic mirrors into
      # `windowStateByChannel`, redrawing the row the operator just refused.
      assert Wire.window_invite_declined("azzurra", "#grappa") == %{
               kind: :window_invite_declined,
               network: "azzurra",
               channel: "#grappa"
             }
    end
  end

  describe "join_failed/4" do
    test "carries the failure reason + numeric" do
      assert Wire.join_failed("azzurra", "#grappa", "Cannot join (+i)", 473) == %{
               kind: :join_failed,
               network: "azzurra",
               channel: "#grappa",
               state: :failed,
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
               state: :kicked,
               by: "op-vjt",
               reason: "be quiet"
             }
    end

    test "tolerates nil by + nil reason from un-recorded kick meta" do
      assert Wire.kicked("azzurra", "#grappa", nil, nil) == %{
               kind: :kicked,
               network: "azzurra",
               channel: "#grappa",
               state: :kicked,
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
               state: :present
             }

      assert Wire.away_confirmed("azzurra", :away) == %{
               kind: :away_confirmed,
               network: "azzurra",
               state: :away
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
               state: :connecting
             }

      assert Wire.connection_progress("azzurra", :connected) == %{
               kind: :connection_progress,
               network: "azzurra",
               state: :connected
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
      accum = %WhoisAccum{
        user: "alice_u",
        host: "alice.host",
        realname: "Alice Liddell",
        server: "irc.azzurra.org",
        server_info: "Azzurra Hub",
        is_operator: true,
        oper_text: "is an IRC Operator",
        idle_seconds: 42,
        signon: 1_700_000_000,
        channels: ["@#italia", "+#grappa"]
      }

      payload = Wire.whois_bundle("azzurra", "alice", accum)

      assert payload == %{
               kind: :whois_bundle,
               network: "azzurra",
               target: "alice",
               # #606 — request origin; defaults to :user for an accum with no
               # :source (this test primes none).
               source: :user,
               user: "alice_u",
               host: "alice.host",
               realname: "Alice Liddell",
               server: "irc.azzurra.org",
               server_info: "Azzurra Hub",
               is_operator: true,
               # #367 — upstream ircd role text captured verbatim alongside
               # the is_operator boolean (distinguishes oper levels).
               oper_text: "is an IRC Operator",
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
               actually_ip: nil,
               # #221 — solanum WHOIS-leg fields (default nil / false when
               # the corresponding numeric did not fire).
               account: nil,
               secure: false,
               secure_cipher: nil,
               certfp: nil,
               extra_lines: nil
             }
    end

    test "tolerates an empty accum (no numerics fired before 318) — every field nil; is_operator false" do
      payload = Wire.whois_bundle("azzurra", "ghost", %WhoisAccum{})

      assert payload == %{
               kind: :whois_bundle,
               network: "azzurra",
               target: "ghost",
               # #606 — empty accum → origin defaults to :user.
               source: :user,
               user: nil,
               host: nil,
               realname: nil,
               server: nil,
               server_info: nil,
               is_operator: false,
               # #367 — bare bundle (no 313, or 313 with no role text): nil.
               oper_text: nil,
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
               actually_ip: nil,
               # #221 defaults
               account: nil,
               secure: false,
               secure_cipher: nil,
               certfp: nil,
               extra_lines: nil
             }
    end

    test "#221 — projects solanum fields (account/secure/certfp/actually_ip/extra_lines)" do
      accum = %WhoisAccum{
        account: "AliceAccount",
        secure: true,
        secure_cipher: "TLSv1.3, TLS_AES_256_GCM_SHA384",
        certfp: "deadbeefcafef00d",
        actually_host: "real-host.example.net",
        actually_ip: "203.0.113.7",
        extra_lines: [%{numeric: 320, text: "is a volunteer staff member"}]
      }

      payload = Wire.whois_bundle("libera", "alice", accum)

      assert payload.account == "AliceAccount"
      assert payload.secure == true
      assert payload.secure_cipher == "TLSv1.3, TLS_AES_256_GCM_SHA384"
      assert payload.certfp == "deadbeefcafef00d"
      assert payload.actually_host == "real-host.example.net"
      assert payload.actually_ip == "203.0.113.7"
      assert payload.extra_lines == [%{numeric: 320, text: "is a volunteer staff member"}]
    end

    # #606 — the request origin rides in the accum as :source and projects
    # verbatim. :rail is the query-rail auto-fetch; anything else defaults to
    # :user (proven by the two exact-map tests above, which prime no :source).
    test "projects the accum :source (rail auto-fetch) into the wire shape" do
      payload = Wire.whois_bundle("azzurra", "alice", %WhoisAccum{source: :rail})
      assert payload.source == :rail
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
      accum = %LusersAccum{
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
      payload = Wire.lusers_bundle("net", %LusersAccum{total_users: 42})

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
      accum = %WhowasAccum{
        target_display: "Alice",
        entries: [
          %WhowasAccum.Entry{
            user: "alice_u",
            host: "alice.host",
            realname: "Alice Liddell",
            server: "irc.test.org",
            logoff_time: "Mon May 13 12:34:56 2026"
          },
          %WhowasAccum.Entry{user: "old_u", host: "old.host", realname: "Old Alice"}
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
      payload = Wire.whowas_bundle("net", "ghost", %WhowasAccum{not_found: true})

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
      payload = Wire.whowas_bundle("net", "alice", %WhowasAccum{})

      assert payload.kind == :whowas_bundle
      assert payload.target == "alice"
      assert payload.not_found == false
      assert payload.user == nil
      assert payload.logoff_time == nil
    end
  end

  # #376 — BANLIST bundle. Unlike whowas (projects only the most-recent
  # entry) the banlist ships ALL entries — a channel's ban list is a set
  # of rows. EventRouter stores entries reversed (O(1) prepend); the wire
  # builder restores wire order.
  describe "banlist_bundle/4" do
    test "ships all entries in wire order with mask/setter/set_ts" do
      # EventRouter prepends (head = most recent 367); wire builder reverses.
      accum = %ListModeAccum{
        channel_display: "#Test",
        entries: [
          %ListModeAccum.Entry{mask: "b!*@2", setter: "op2", set_ts: "222"},
          %ListModeAccum.Entry{mask: "a!*@1", setter: "op1", set_ts: "111"}
        ]
      }

      payload = Wire.banlist_bundle("azzurra", "#Test", "b", accum)

      assert payload == %{
               kind: :banlist_bundle,
               network: "azzurra",
               channel: "#Test",
               mode: "b",
               entries: [
                 %{mask: "a!*@1", setter: "op1", set_ts: "111"},
                 %{mask: "b!*@2", setter: "op2", set_ts: "222"}
               ]
             }
    end

    test "empty entries → empty list (channel with no bans)" do
      payload = Wire.banlist_bundle("net", "#empty", "b", %ListModeAccum{channel_display: "#empty"})

      assert payload == %{
               kind: :banlist_bundle,
               network: "net",
               channel: "#empty",
               mode: "b",
               entries: []
             }
    end

    # #1251 — the kind stays `banlist_bundle` (additive-only wire, GH #447);
    # `mode` is what tells the client WHICH list it got. A bundle that
    # dropped it would render solanum's quiet list as a ban list.
    test "carries the queried mode letter verbatim (not always b)" do
      accum = %ListModeAccum{
        channel_display: "#c",
        entries: [%ListModeAccum.Entry{mask: "*!*@muted", setter: "op", set_ts: "1"}]
      }

      assert Wire.banlist_bundle("libera", "#c", "q", accum).mode == "q"
      assert Wire.banlist_bundle("azzurra", "#c", "z", accum).mode == "z"
      assert Wire.banlist_bundle("libera", "#c", "I", accum).mode == "I"
    end

    test "entry with nil setter/set_ts (older ircd) round-trips nils" do
      accum = %ListModeAccum{
        channel_display: "#c",
        entries: [%ListModeAccum.Entry{mask: "*!*@h", setter: nil, set_ts: nil}]
      }

      payload = Wire.banlist_bundle("net", "#c", "b", accum)

      assert payload.entries == [%{mask: "*!*@h", setter: nil, set_ts: nil}]
    end
  end

  describe "links_bundle/2 (#238)" do
    test "ships all topology entries in wire order (reverses EventRouter's prepend)" do
      # EventRouter prepends (head = most recent 364); wire builder reverses
      # so the wire order matches the ircd emit order (root first).
      accum = %LinksAccum{
        entries: [
          %LinksAccum.Entry{server: "leaf.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 1, description: "Leaf"},
          %LinksAccum.Entry{server: "hub.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 0, description: "Hub"}
        ]
      }

      payload = Wire.links_bundle("azzurra", accum)

      assert payload == %{
               kind: :links_bundle,
               network: "azzurra",
               mask: nil,
               entries: [
                 %{server: "hub.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 0, description: "Hub"},
                 %{server: "leaf.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 1, description: "Leaf"}
               ]
             }
    end

    test "empty entries + no mask → empty list, mask nil (restricted/hidden topology)" do
      payload = Wire.links_bundle("net", %LinksAccum{})

      assert payload == %{kind: :links_bundle, network: "net", mask: nil, entries: []}
    end

    test "#513a — carries the requested mask so cic can split the empty state" do
      # An empty bundle WITH a mask means the mask matched nothing (e.g.
      # `/links all` answered with a bare 365) — cic renders "no server
      # matches <mask>", not "hides topology".
      payload = Wire.links_bundle("net", %LinksAccum{mask: "all"})

      assert payload == %{kind: :links_bundle, network: "net", mask: "all", entries: []}
    end

    test "entry with nil linked_to/hopcount/description (malformed line) round-trips nils" do
      accum =
        %LinksAccum{
          entries: [
            %LinksAccum.Entry{server: "s.host", linked_to: nil, hopcount: nil, description: nil}
          ]
        }

      payload = Wire.links_bundle("net", accum)

      assert payload.entries == [%{server: "s.host", linked_to: nil, hopcount: nil, description: nil}]
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
        Wire.whois_bundle("net", "alice", %WhoisAccum{}),
        Wire.peer_away("net", "alice", "Gone fishing"),
        Wire.invite_ack("net", "#italia", "alice"),
        Wire.lusers_bundle("net", %LusersAccum{}),
        Wire.whowas_bundle("net", "alice", %WhowasAccum{}),
        Wire.whowas_bundle("net", "ghost", %WhowasAccum{not_found: true}),
        Wire.banlist_bundle("net", "#c", "b", %ListModeAccum{channel_display: "#c"}),
        Wire.links_bundle("net", %LinksAccum{}),
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
