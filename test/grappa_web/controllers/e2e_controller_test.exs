defmodule GrappaWeb.E2eControllerTest do
  @moduledoc """
  `/networks/:network_id/e2e/*` (issue 2430, wire v2 multi-device) — the
  send door of an end-to-end encrypted query, each device's offline queue,
  and the E2E identity grappa answers a KEYREQ from.

  What the suite pins beyond the happy path: the door maps the wire's
  lowercase verbs onto the facade's closed set and nothing else (a client
  may not send `keys`, and `offline` no longer exists); only a device the
  master listed may speak; every refusal is a status a client can act on
  rather than a 500; and the lines really reach the upstream wire, read
  back off the fake ircd.

  `async: false` for the usual singleton reason (`Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub`).
  """
  use GrappaWeb.ConnCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{E2eFixtures, E2eInbox, E2eKeys, IRCServer, Repo}
  alias Grappa.E2eKeys.DeviceList
  alias Grappa.IRC.E2e
  alias Grappa.Scrollback.Message
  alias Grappa.Session.E2ePacer
  alias Grappa.Session.Wire, as: SessionWire

  # The peer's device, as its frames name it.
  @alice "AaZaARRDyBk"

  # Compact JSON text, what a v2 frame carries as is.
  @payload ~s({"v":2})

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{u()}")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
  end

  defp u, do: System.unique_integer([:positive])

  # Mirrors `InvitesControllerTest`: the port must stay inside the range
  # `Networks.Server` accepts under a full-suite run.
  defp unique_port, do: 1024 + rem(System.unique_integer([:positive]), 60_000)

  # A did is base64url, so it goes into the path as it is.
  defp device_path(network, did), do: "/networks/#{network.slug}/e2e/devices/#{did}"

  # A payload of compact JSON text big enough to need several lines.
  defp payload(bytes), do: ~s({"v":2,"body":"#{Base.encode64(:crypto.strong_rand_bytes(bytes))}"})

  # A live session for vjt on a fresh network, and vjt's E2E identity
  # there: one device, registered and listed. Every send names it as
  # `from`.
  defp live_network(vjt) do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {network, _} = network_with_server(port: port, slug: "azzurra-#{u()}")
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    device = listed_device!(vjt, network)
    pid = start_session_for(vjt, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid, :normal, 1_000) end)
    {server, network, device}
  end

  defp listed_device!(user, network) do
    master = E2eFixtures.identity()
    %{attrs: attrs} = E2eFixtures.device(master)
    {:ok, device} = E2eKeys.register_device({:user, user.id}, network.id, attrs)
    {:ok, _} = E2eKeys.put_list({:user, user.id}, network.id, E2eFixtures.list(master, 1, [attrs.ed25519]))
    device
  end

  describe "the send door" do
    test "202 with the msgid, and the line reaches the upstream wire", %{conn: conn, vjt: vjt} do
      {server, network, device} = live_network(vjt)
      body = %{target: "alice", verb: "keyreq", from: device.did, to: "*", payload: @payload}

      assert %{"msgid" => msgid} = json_response(post(conn, "/networks/#{network.slug}/e2e/messages", body), 202)
      assert E2e.msgid?(msgid)

      assert {:ok, line} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 1_000)
      assert line == "PRIVMSG alice :\x01E2E KEYREQ #{msgid} 1/1 #{device.did} * #{@payload}\x01\r\n"
    end

    test "control and reactive go ahead of queued text, and a keyreq whatever it says", %{conn: conn, vjt: vjt} do
      {server, network, device} = live_network(vjt)
      path = "/networks/#{network.slug}/e2e/messages"
      msg = %{target: "alice", verb: "msg", from: device.did, to: @alice}

      # A long text message: its full lines drip one per 5 s on the
      # connection's fake-lag bank, so line 2 is seconds away.
      %{"msgid" => long_id} = json_response(post(conn, path, Map.put(msg, :payload, payload(1_200))), 202)
      {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{long_id} 1/"), 10_000)

      # A CHAL/ACK carrier marked control, a device list marked reactive,
      # and a keyreq that asks for text.
      %{"msgid" => ack_id} =
        json_response(post(conn, path, Map.merge(msg, %{payload: @payload, priority: "control"})), 202)

      %{"msgid" => list_id} =
        json_response(post(conn, path, Map.merge(msg, %{payload: @payload, priority: "reactive"})), 202)

      keyreq = %{msg | verb: "keyreq", to: "*"}

      %{"msgid" => keyreq_id} =
        json_response(post(conn, path, Map.merge(keyreq, %{payload: @payload, priority: "text"})), 202)

      for id <- [ack_id, list_id, keyreq_id] do
        {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, id), 10_000)
      end

      refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "#{long_id} 2/"))
    end

    test "400 for a verb outside the client set, an unknown priority, a non-nick target, addresses the verb may not carry, a payload that is not compact JSON text",
         %{conn: conn, vjt: vjt} do
      {_, network, device} = live_network(vjt)
      path = "/networks/#{network.slug}/e2e/messages"
      ok = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: @payload}

      for body <- [
            %{ok | verb: "keys"},
            %{ok | verb: "offline"},
            %{ok | verb: "MSG"},
            %{ok | target: "#italia"},
            Map.put(ok, :priority, "urgent"),
            Map.put(ok, :priority, "CONTROL"),
            # KEYREQ goes to every device, MSG from one, NACK to one.
            %{ok | verb: "keyreq"},
            %{ok | from: "*"},
            %{ok | verb: "nack", to: "*"},
            %{ok | from: "short"},
            %{ok | to: "AaZaARRDyB!"},
            Map.delete(ok, :from),
            Map.delete(ok, :to),
            %{ok | from: 42},
            # A space, nothing at all, a byte past ASCII, not a string.
            %{ok | payload: ~s({"v": 2})},
            %{ok | payload: ""},
            %{ok | payload: ~s({"v":"é"})},
            Map.delete(ok, :payload),
            %{ok | payload: 42}
          ] do
        assert json_response(post(conn, path, body), 400) == %{"error" => "bad_request"}, inspect(body)
      end

      assert %{"msgid" => _} = json_response(post(conn, path, ok), 202)
    end

    test "422 unknown_device when from is not a device the master listed", %{conn: conn, vjt: vjt} do
      {_, network, device} = live_network(vjt)
      path = "/networks/#{network.slug}/e2e/messages"
      ok = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: @payload}

      # Registered but never listed: a device being paired.
      %{attrs: attrs} = E2eFixtures.device(E2eFixtures.identity())
      {:ok, pairing} = E2eKeys.register_device({:user, vjt.id}, network.id, attrs)

      # Listed, but under another subject.
      other = user_fixture(name: "other-#{u()}")
      _ = credential_fixture(other, network, %{nick: "someone", autojoin_channels: []})
      theirs = listed_device!(other, network)

      for from <- [pairing.did, theirs.did, @alice] do
        assert json_response(post(conn, path, %{ok | from: from}), 422) == %{"error" => "unknown_device"}, from
      end
    end

    test "expires_at: a control msg/pkmsg's deadline in unix seconds; 400 elsewhere or not an integer, 422 too_late once it cannot be met",
         %{conn: conn, vjt: vjt} do
      {server, network, device} = live_network(vjt)
      path = "/networks/#{network.slug}/e2e/messages"
      soon = System.os_time(:second) + 15
      ack = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: @payload, priority: "control"}

      for body <- [
            Map.put(ack, :expires_at, "#{soon}"),
            Map.put(ack, :expires_at, soon + 0.5),
            Map.put(ack, :expires_at, 0),
            Map.put(ack, :expires_at, -soon),
            Map.put(%{ack | priority: "text"}, :expires_at, soon),
            Map.put(%{ack | priority: "reactive"}, :expires_at, soon),
            ack |> Map.delete(:priority) |> Map.put(:expires_at, soon),
            Map.put(%{ack | verb: "keyreq", to: "*"}, :expires_at, soon),
            Map.put(%{ack | verb: "nack"}, :expires_at, soon)
          ] do
        assert json_response(post(conn, path, body), 400) == %{"error" => "bad_request"}, inspect(body)
      end

      late = Map.put(ack, :expires_at, System.os_time(:second))
      assert json_response(post(conn, path, late), 422) == %{"error" => "too_late"}

      %{"msgid" => msgid} = json_response(post(conn, path, Map.put(ack, :expires_at, soon)), 202)
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 1_000)

      # null is absent.
      assert %{"msgid" => _} = json_response(post(conn, path, Map.put(ack, :expires_at, nil)), 202)
    end

    test "413 too_large for a payload past 64 lines", %{conn: conn, vjt: vjt} do
      {_, network, device} = live_network(vjt)
      # Under 32 KiB, but no line carries more than a few hundred bytes.
      huge = String.duplicate("A", E2e.max_payload_bytes() - 1)
      body = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: huge}

      assert json_response(post(conn, "/networks/#{network.slug}/e2e/messages", body), 413) == %{"error" => "too_large"}
    end

    test "413 for a payload no receiver can hold, decided before any session or device is asked", %{
      conn: conn,
      vjt: vjt
    } do
      # No session runs for this network and vjt holds no device there: a
      # refusal that needed either would come back as something else. 32 KiB
      # is what a receiver buffers per sender (2430), so a larger payload can
      # never be reassembled.
      {network, _} = network_with_server(port: unique_port(), slug: "idle-#{u()}")
      _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
      huge = String.duplicate("A", E2e.max_payload_bytes() + 1)
      body = %{target: "alice", verb: "msg", from: @alice, to: "*", payload: huge}

      assert json_response(post(conn, "/networks/#{network.slug}/e2e/messages", body), 413) == %{"error" => "too_large"}
    end

    test "429 rate_limited when the recipient's queue cannot take the whole message", %{conn: conn, vjt: vjt} do
      {_, network, device} = live_network(vjt)
      path = "/networks/#{network.slug}/e2e/messages"
      # About 55 full lines each on a 512-byte wire, some 330 s of fake-lag
      # bank: the first fits the 480 s of text a connection queues, the
      # second does not.
      body = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: payload(15_000)}
      assert E2ePacer.max_backlog_ms() == 480_000

      assert %{"msgid" => _} = json_response(post(conn, path, body), 202)
      assert json_response(post(conn, path, body), 429)["error"] == "rate_limited"
    end

    test "another subject's network is not reachable", %{conn: conn, vjt: vjt} do
      other = user_fixture(name: "other-#{u()}")
      {network, _} = network_with_server(port: unique_port(), slug: "other-#{u()}")
      _ = credential_fixture(other, network, %{nick: "someone"})
      device = listed_device!(other, network)
      _ = vjt
      body = %{target: "alice", verb: "msg", from: device.did, to: @alice, payload: @payload}

      assert post(conn, "/networks/#{network.slug}/e2e/messages", body).status == 404
    end
  end

  describe "a device's offline queue" do
    # No session runs: the queue is a resource of its own, read and acked
    # straight through the context. Entries go in the way the session puts
    # them, one queue per device.
    defp idle_network(vjt) do
      {network, _} = network_with_server(port: unique_port(), slug: "inbox-#{u()}")
      _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
      network
    end

    defp queue!(device, sender, verb) do
      {:ok, entry} =
        E2eInbox.put(device, %{sender: sender, from_did: @alice, verb: verb, msgid: "q83vEjRWeJA", payload: @payload})

      entry
    end

    defp inbox_path(network, device), do: "#{device_path(network, device.did)}/inbox"

    test "GET lists what waits for the device, oldest first, in the same shape the push carries", %{
      conn: conn,
      vjt: vjt
    } do
      network = idle_network(vjt)
      device = listed_device!(vjt, network)
      a = queue!(device, "alice", :pkmsg)
      b = queue!(device, "bob", :msg)

      # Through the production renderer and the JSON encoder, the way the
      # push leaves too: one shape for a pushed message and a fetched one.
      expected =
        [a, b]
        |> Enum.map(&SessionWire.e2e_message(network.slug, device.did, &1))
        |> Jason.encode!()
        |> Jason.decode!()

      assert json_response(get(conn, inbox_path(network, device)), 200) == %{"messages" => expected}
      assert [%{"from_did" => @alice, "to_did" => did} | _] = expected
      assert did == device.did
    end

    test "GET pages past ?after, and refuses a cursor that is not a count", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      device = listed_device!(vjt, network)
      a = queue!(device, "alice", :msg)
      b = queue!(device, "alice", :msg)
      path = inbox_path(network, device)

      assert [%{"id" => id}] = json_response(get(conn, path, %{after: a.id}), 200)["messages"]
      assert id == b.id
      assert json_response(get(conn, path, %{after: b.id}), 200)["messages"] == []

      # Past int64 the bind would fail inside exqlite: a 500, not a 400.
      for bad <- ["x", "-1", "1.5", "", "9223372036854775808"] do
        assert json_response(get(conn, path, %{after: bad}), 400) == %{"error" => "bad_request"}, inspect(bad)
      end
    end

    test "GET shows a device only its own queue; another subject's device is a 404", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      device = listed_device!(vjt, network)
      %{attrs: attrs} = E2eFixtures.device(E2eFixtures.identity())
      {:ok, sibling} = E2eKeys.register_device({:user, vjt.id}, network.id, attrs)
      _ = queue!(sibling, "alice", :msg)
      other = user_fixture(name: "other-#{u()}")
      theirs = listed_device!(other, network)
      _ = queue!(theirs, "alice", :msg)

      assert json_response(get(conn, inbox_path(network, device)), 200)["messages"] == []
      assert [_] = json_response(get(conn, inbox_path(network, sibling)), 200)["messages"]
      assert json_response(get(conn, inbox_path(network, theirs)), 404) == %{"error" => "not_found"}
    end

    test "POST ack deletes the named entries of that device; another device's ids are out of reach", %{
      conn: conn,
      vjt: vjt
    } do
      network = idle_network(vjt)
      device = listed_device!(vjt, network)
      mine = queue!(device, "alice", :msg)
      kept = queue!(device, "alice", :msg)
      %{attrs: attrs} = E2eFixtures.device(E2eFixtures.identity())
      {:ok, sibling} = E2eKeys.register_device({:user, vjt.id}, network.id, attrs)
      siblings = queue!(sibling, "alice", :msg)
      other = user_fixture(name: "other-#{u()}")
      theirs_device = listed_device!(other, network)
      theirs = queue!(theirs_device, "alice", :msg)

      resp = post(conn, "#{inbox_path(network, device)}/ack", %{ids: [mine.id, siblings.id, theirs.id]})

      assert response(resp, 204) == ""
      assert [%E2eInbox.Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == kept.id
      assert [%E2eInbox.Entry{}] = E2eInbox.list(sibling, 0)
      assert [%E2eInbox.Entry{}] = E2eInbox.list(theirs_device, 0)

      assert json_response(post(conn, "#{inbox_path(network, theirs_device)}/ack", %{ids: [theirs.id]}), 404) ==
               %{"error" => "not_found"}

      assert [%E2eInbox.Entry{}] = E2eInbox.list(theirs_device, 0)
    end

    test "the test-only expire door runs the session's sweep: the queue empties, the recipient is told for the device",
         %{conn: conn, vjt: vjt} do
      {_, network, device} = live_network(vjt)
      _ = queue!(device, "alice", :msg)

      conn = post(conn, "/networks/#{network.slug}/e2e/inbox/expire")

      assert response(conn, 204) == ""
      assert E2eInbox.list(device, 0) == []

      assert [%Message{kind: :server_event, channel: "alice", meta: meta}] =
               Message |> where([m], m.network_id == ^network.id and m.kind == :server_event) |> Repo.all()

      assert meta == %{e2e_undeliverable: 1, e2e_device: device.did}
    end

    test "POST ack refuses what is not a short list of ids", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      device = listed_device!(vjt, network)
      path = "#{inbox_path(network, device)}/ack"
      too_many = Enum.to_list(1..(E2eInbox.page_size() + 1))

      for body <- [
            %{},
            %{ids: []},
            %{ids: "1"},
            %{ids: [0]},
            %{ids: [-1]},
            %{ids: ["1"]},
            %{ids: [1.5]},
            %{ids: [9_223_372_036_854_775_808]},
            %{ids: too_many}
          ] do
        assert json_response(post(conn, path, body), 400) == %{"error" => "bad_request"}, inspect(body)
      end
    end
  end

  describe "the E2E identity (multi-device)" do
    defp bundle_network(vjt) do
      {network, _} = network_with_server(port: unique_port(), slug: "keys-#{u()}")
      _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
      network
    end

    defp key_body(identity), do: Map.new(E2eFixtures.signed_key(identity), fn {k, v} -> {Atom.to_string(k), v} end)

    test "a device registers, the master puts its list, the device uploads its keys; DELETE drops it all",
         %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      base = "/networks/#{network.slug}/e2e"
      master = E2eFixtures.identity()
      %{identity: identity, attrs: attrs} = E2eFixtures.device(master)

      assert %{"did" => did} = device = json_response(post(conn, "#{base}/devices", attrs), 200)
      assert {:ok, did} == E2eKeys.Device.did(attrs.ed25519)
      assert device == %{"did" => did, "ed25519" => attrs.ed25519, "curve25519" => attrs.curve25519, "sig" => attrs.sig}
      assert json_response(get(conn, "#{base}/devices"), 200) == %{"devices" => [device]}

      assert json_response(get(conn, "#{base}/list"), 404) == %{"error" => "not_found"}
      list = E2eFixtures.list(master, 1, [attrs.ed25519])
      expected = %{"master" => master.public, "ver" => 1, "devices" => list.devices, "sig" => list.sig}
      assert json_response(put(conn, "#{base}/list", list), 200) == expected
      assert json_response(get(conn, "#{base}/list"), 200) == expected

      keys = "#{device_path(network, did)}/keys"
      assert json_response(get(conn, keys), 200) == %{"one_time_keys" => 0, "fallback" => false}

      body = %{one_time_keys: [key_body(identity), key_body(identity)], fallback: key_body(identity)}
      assert json_response(post(conn, keys, body), 200) == %{"one_time_keys" => 2, "fallback" => true}

      # Replenishing adds one-time keys; leaving out the fallback key keeps
      # it, and a null field reads as absent.
      assert json_response(post(conn, keys, %{one_time_keys: [key_body(identity)], fallback: nil}), 200) ==
               %{"one_time_keys" => 3, "fallback" => true}

      assert json_response(post(conn, keys, %{one_time_keys: nil, fallback: key_body(identity)}), 200) ==
               %{"one_time_keys" => 3, "fallback" => true}

      assert response(delete(conn, "#{base}/keys"), 204) == ""
      assert E2eKeys.devices({:user, vjt.id}, network.id) == []
      assert {:error, :not_found} = E2eKeys.list({:user, vjt.id}, network.id)
      assert json_response(get(conn, keys), 404) == %{"error" => "not_found"}
    end

    test "every refusal is a status the client can act on", %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      base = "/networks/#{network.slug}/e2e"
      master = E2eFixtures.identity()

      devices =
        for _ <- 1..DeviceList.max_devices() do
          %{attrs: attrs} = device = E2eFixtures.device(master)
          %{"did" => did} = json_response(post(conn, "#{base}/devices", attrs), 200)
          Map.put(device, :did, did)
        end

      assert json_response(post(conn, "#{base}/devices", %{}), 400) == %{"error" => "bad_request"}

      assert json_response(post(conn, "#{base}/devices", E2eFixtures.device(master).attrs), 409) ==
               %{"error" => "too_many_devices"}

      [a, b | _] = Enum.map(devices, & &1.attrs.ed25519)
      {:ok, _} = E2eKeys.put_list({:user, vjt.id}, network.id, E2eFixtures.list(master, 2, [a]))

      assert json_response(put(conn, "#{base}/list", %{E2eFixtures.list(master, 3, [a]) | ver: 4}), 400) ==
               %{"error" => "bad_request"}

      assert json_response(put(conn, "#{base}/list", E2eFixtures.list(master, 2, [a, b])), 409) ==
               %{"error" => "stale_list"}

      assert json_response(put(conn, "#{base}/list", E2eFixtures.list(E2eFixtures.identity(), 3, [a])), 409) ==
               %{"error" => "master_mismatch"}

      stranger = E2eFixtures.identity().public

      assert json_response(put(conn, "#{base}/list", E2eFixtures.list(master, 3, [a, stranger])), 422) ==
               %{"error" => "unknown_device"}

      [%{identity: identity, did: did} | _] = devices
      keys = "#{device_path(network, did)}/keys"

      for body <- [
            %{},
            %{one_time_keys: []},
            %{one_time_keys: "x"},
            %{one_time_keys: [1]},
            %{one_time_keys: ["a v1 payload"]},
            %{one_time_keys: [%{key_body(identity) | "key" => "not a key"}]},
            %{one_time_keys: [Map.delete(key_body(identity), "sig")]},
            %{fallback: 1},
            %{fallback: %{key_body(identity) | "sig" => "not a signature"}}
          ] do
        assert json_response(post(conn, keys, body), 400) == %{"error" => "bad_request"}, inspect(body)
      end

      too_many = for _ <- 1..(E2eKeys.max_one_time_keys() + 1), do: key_body(identity)
      assert json_response(post(conn, keys, %{one_time_keys: too_many}), 413) == %{"error" => "too_large"}

      assert json_response(get(conn, "#{device_path(network, "AAAAAAAAAAA")}/keys"), 404) == %{"error" => "not_found"}

      assert json_response(
               post(conn, "#{device_path(network, "AAAAAAAAAAA")}/keys", %{fallback: key_body(identity)}),
               404
             )
    end

    test "DELETE drops a device the list does not name, freeing its room; a listed one is 409 listed_device",
         %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      base = "/networks/#{network.slug}/e2e"
      master = E2eFixtures.identity()
      [%{attrs: listed}, %{attrs: pairing}] = for _ <- 1..2, do: E2eFixtures.device(master)
      %{"did" => listed_did} = json_response(post(conn, "#{base}/devices", listed), 200)
      %{"did" => pairing_did} = json_response(post(conn, "#{base}/devices", pairing), 200)
      _ = json_response(put(conn, "#{base}/list", E2eFixtures.list(master, 1, [listed.ed25519])), 200)

      assert json_response(delete(conn, device_path(network, listed_did)), 409) == %{"error" => "listed_device"}
      assert response(delete(conn, device_path(network, pairing_did)), 204) == ""
      assert json_response(delete(conn, device_path(network, pairing_did)), 404) == %{"error" => "not_found"}
      assert [%{"did" => ^listed_did}] = json_response(get(conn, "#{base}/devices"), 200)["devices"]
    end

    test "a did holding `-` and `_` reaches every device route as it is", %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      master = E2eFixtures.identity()

      # About one did in 50 holds both. The draws are bounded, so a did
      # back in the standard alphabet (which has neither) fails here
      # instead of drawing forever.
      draw = fn -> E2eFixtures.device(master) end
      draws = draw |> Stream.repeatedly() |> Stream.take(2_000)

      assert %{identity: identity, attrs: attrs} =
               Enum.find(draws, fn %{attrs: %{ed25519: ed25519}} ->
                 {:ok, did} = E2eKeys.Device.did(ed25519)
                 String.contains?(did, "-") and String.contains?(did, "_")
               end)

      {:ok, device} = E2eKeys.register_device({:user, vjt.id}, network.id, attrs)
      path = device_path(network, device.did)

      assert json_response(post(conn, "#{path}/keys", %{fallback: key_body(identity)}), 200) ==
               %{"one_time_keys" => 0, "fallback" => true}

      assert json_response(get(conn, "#{path}/keys"), 200) == %{"one_time_keys" => 0, "fallback" => true}
      assert json_response(get(conn, "#{path}/inbox"), 200) == %{"messages" => []}
      assert response(post(conn, "#{path}/inbox/ack", %{ids: [1]}), 204) == ""
      assert response(delete(conn, path), 204) == ""
      assert E2eKeys.devices({:user, vjt.id}, network.id) == []
    end

    test "the very list held, put again, is a 200", %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      base = "/networks/#{network.slug}/e2e"
      master = E2eFixtures.identity()
      %{attrs: attrs} = E2eFixtures.device(master)
      _ = json_response(post(conn, "#{base}/devices", attrs), 200)
      list = E2eFixtures.list(master, 1, [attrs.ed25519])

      first = json_response(put(conn, "#{base}/list", list), 200)
      assert json_response(put(conn, "#{base}/list", list), 200) == first
    end

    test "another subject's identity is out of reach", %{conn: conn, vjt: vjt} do
      other = user_fixture(name: "other-#{u()}")
      {network, _} = network_with_server(port: unique_port(), slug: "other-#{u()}")
      _ = credential_fixture(other, network, %{nick: "someone"})
      master = E2eFixtures.identity()
      %{identity: identity, attrs: attrs} = E2eFixtures.device(master)
      {:ok, device} = E2eKeys.register_device({:user, other.id}, network.id, attrs)
      {:ok, _} = E2eKeys.upload(device, %{one_time_keys: [E2eFixtures.signed_key(identity)], fallback: nil})
      _ = vjt
      base = "/networks/#{network.slug}/e2e"

      assert get(conn, "#{base}/devices").status == 404
      assert get(conn, "#{device_path(network, device.did)}/keys").status == 404
      assert post(conn, "#{device_path(network, device.did)}/keys", %{fallback: key_body(identity)}).status == 404
      assert put(conn, "#{base}/list", E2eFixtures.list(master, 1, [attrs.ed25519])).status == 404
      assert delete(conn, "#{base}/keys").status == 404
      assert delete(conn, device_path(network, device.did)).status == 404
      assert E2eKeys.status(device) == %{one_time_keys: 1, fallback: false}
    end

    test "on vjt's own network, another subject's device did is a 404 too", %{conn: conn, vjt: vjt} do
      network = bundle_network(vjt)
      other = user_fixture(name: "other-#{u()}")
      %{attrs: attrs} = E2eFixtures.device(E2eFixtures.identity())
      {:ok, device} = E2eKeys.register_device({:user, other.id}, network.id, attrs)

      assert json_response(get(conn, "#{device_path(network, device.did)}/keys"), 404)
      assert json_response(delete(conn, device_path(network, device.did)), 404)
      assert json_response(get(conn, "/networks/#{network.slug}/e2e/devices"), 200) == %{"devices" => []}
      assert [_] = E2eKeys.devices({:user, other.id}, network.id)
    end
  end
end
