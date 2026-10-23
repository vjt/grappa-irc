defmodule Grappa.E2eKeysTest do
  @moduledoc """
  issue 2430, multi-device — the E2E identity grappa hosts for a subject
  on a network: its devices, its signed device list, and each device's key
  bundle, from which grappa composes the KEYS it answers a peer's KEYREQ
  with (wire v2).

  Every key and signature is real (`Grappa.E2eFixtures`). Every test goes
  through the context.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{E2eFixtures, E2eInbox, E2eKeys, Repo}
  alias Grappa.E2eInbox.Entry
  alias Grappa.E2eKeys.{Device, DeviceList, Key}

  setup do
    user = user_fixture()
    {:ok, subject: {:user, user.id}, network: network_fixture(), master: E2eFixtures.identity()}
  end

  # A registered device of `subject` and the identity that signs for it.
  defp device(subject, network, master) do
    %{identity: identity, attrs: attrs} = E2eFixtures.device(master)
    {:ok, %Device{} = device} = E2eKeys.register_device(subject, network.id, attrs)
    %{device: device, identity: identity}
  end

  defp otks(%{identity: identity}, n), do: for(_ <- 1..n, do: E2eFixtures.signed_key(identity))
  defp fallback(%{identity: identity}), do: E2eFixtures.signed_key(identity)

  defp upload(%{device: device}, otks, fallback),
    do: E2eKeys.upload(device, %{one_time_keys: otks, fallback: fallback})

  defp listed(subject, network, master, devices, ver) do
    keys = Enum.map(devices, & &1.device.ed25519)
    {:ok, %DeviceList{}} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, ver, keys))
  end

  defp decode!(payload), do: Jason.decode!(payload)

  defp inbox_message,
    do: %{sender: "alice", from_did: "AaZaARRDyBk", verb: :msg, msgid: "q83vEjRWeJA", payload: ~s({"v":2})}

  describe "upload/2 and status/1" do
    setup %{subject: subject, network: network, master: master} do
      {:ok, dev: device(subject, network, master)}
    end

    test "an empty bundle reads zero keys and no fallback", %{dev: dev} do
      assert E2eKeys.status(dev.device) == %{one_time_keys: 0, fallback: false}
    end

    test "a device dropped since the caller read it takes no upload: :not_found, not a raise",
         %{subject: subject, network: network, dev: dev} do
      :ok = E2eKeys.clear(subject, network.id)
      assert {:error, :not_found} = upload(dev, otks(dev, 1), fallback(dev))
      assert Repo.aggregate(Key, :count) == 0
    end

    test "one-time keys add up across uploads; the fallback key is replaced",
         %{subject: subject, network: network, master: master, dev: dev} do
      assert {:ok, %{one_time_keys: 3, fallback: true}} = upload(dev, otks(dev, 3), fallback(dev))

      second = fallback(dev)
      assert {:ok, %{one_time_keys: 5, fallback: true}} = upload(dev, otks(dev, 2), second)

      # One fallback key, the latest: what is handed out once the one-time
      # keys run out.
      listed(subject, network, master, [dev], 1)
      {:ok, payload, _} = E2eKeys.answer(subject, network.id, :fallback)
      assert [%{"otk" => %{"key" => key, "fallback" => true}}] = decode!(payload)["devices"]
      assert key == second.key
    end

    test "an upload without a fallback key keeps the one already there",
         %{subject: subject, network: network, master: master, dev: dev} do
      kept = fallback(dev)
      {:ok, _} = upload(dev, [], kept)
      assert {:ok, %{one_time_keys: 1, fallback: true}} = upload(dev, otks(dev, 1), nil)

      listed(subject, network, master, [dev], 1)
      {:ok, payload, _} = E2eKeys.answer(subject, network.id, :fallback)
      assert [%{"otk" => %{"key" => key}}] = decode!(payload)["devices"]
      assert key == kept.key
    end

    test "at most 50 one-time keys per device, and an upload past that is refused whole",
         %{subject: subject, network: network, master: master, dev: dev} do
      {:ok, %{one_time_keys: 48}} = upload(dev, otks(dev, 48), nil)

      assert {:error, :too_large} = upload(dev, otks(dev, 3), fallback(dev))
      assert {:error, :too_large} = upload(dev, otks(dev, E2eKeys.max_one_time_keys() + 1), nil)

      # Nothing of the refused upload landed, its fallback key included.
      assert E2eKeys.status(dev.device) == %{one_time_keys: 48, fallback: false}
      assert {:ok, %{one_time_keys: 50}} = upload(dev, otks(dev, 2), nil)

      # Another device of the same subject has room of its own.
      other = device(subject, network, master)
      assert {:ok, %{one_time_keys: 50}} = upload(other, otks(other, 50), nil)
    end

    test "refuses an empty upload, or one holding something that is not a key and a signature, whole",
         %{dev: dev} do
      [good] = otks(dev, 1)
      assert {:error, :bad_request} = upload(dev, [], nil)

      for bad <- [
            %{good | key: "not a key"},
            %{good | key: good.key <> "="},
            %{good | sig: good.key},
            Map.delete(good, :sig),
            "a v1 payload string"
          ] do
        assert {:error, :bad_request} = upload(dev, [hd(otks(dev, 1)), bad], nil)
        # A fallback key that is not a map never reaches the context: the
        # send door refuses it as a bad shape.
        if is_map(bad), do: assert({:error, :bad_request} = upload(dev, [], bad))
      end

      assert E2eKeys.status(dev.device) == %{one_time_keys: 0, fallback: false}
    end

    test "a key the device holds as a one-time key cannot become its fallback key", %{dev: dev} do
      [otk] = otks(dev, 1)
      {:ok, _} = upload(dev, [otk], nil)

      assert {:error, :bad_request} = upload(dev, otks(dev, 2), otk)
      assert E2eKeys.status(dev.device) == %{one_time_keys: 1, fallback: false}
    end

    test "a visitor's device holds a bundle of its own", %{network: network, master: master} do
      dev = device({:visitor, visitor_fixture().id}, network, master)
      assert {:ok, %{one_time_keys: 1, fallback: true}} = upload(dev, otks(dev, 1), fallback(dev))
    end
  end

  describe "answer/3 and consume/1" do
    setup %{subject: subject, network: network, master: master} do
      a = device(subject, network, master)
      b = device(subject, network, master)
      {:ok, a: a, b: b}
    end

    test "with no list, or no listed device holding a key, there is nothing to hand out",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(a, otks(a, 1), fallback(a))
      assert {:error, :empty} = E2eKeys.answer(subject, network.id, :otk)

      listed(subject, network, master, [b], 1)
      assert {:error, :empty} = E2eKeys.answer(subject, network.id, :otk)
    end

    test "composes one KEYS v2 covering every listed device: the signed list, then each id block and key",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      [a1, _] = otks(a, 2)
      {:ok, _} = upload(a, [a1 | otks(a, 1)], fallback(a))
      [b1] = otks(b, 1)
      {:ok, _} = upload(b, [b1], nil)
      {:ok, list} = listed(subject, network, master, [a, b], 1)

      assert {:ok, payload, keys} = E2eKeys.answer(subject, network.id, :otk)

      # The compact JSON a frame carries as is: no space, nothing but ASCII.
      refute payload =~ " "
      assert payload =~ ~r/\A[\x21-\x7e]+\z/

      assert %{"v" => 2, "master" => master_block, "devices" => entries} = decode!(payload)

      assert master_block == %{
               "ed25519" => master.public,
               "list" => %{"ver" => 1, "devices" => list.devices},
               "sig" => list.sig
             }

      # In the list's order, each device once, with its oldest one-time key.
      by_key = %{a.device.ed25519 => {a.device, a1}, b.device.ed25519 => {b.device, b1}}

      assert Enum.map(entries, & &1["id"]["ed25519"]) == list.devices

      for %{"id" => id, "otk" => otk} <- entries do
        {device, key} = Map.fetch!(by_key, id["ed25519"])
        assert id == %{"curve25519" => device.curve25519, "ed25519" => device.ed25519, "sig" => device.sig}
        assert otk == %{"key" => key.key, "fallback" => false, "sig" => key.sig}
      end

      assert keys |> Enum.map(& &1.key) |> Enum.sort() == Enum.sort([a1.key, b1.key])
    end

    test "one-time keys go oldest first, each once; a device out of them hands out its fallback key",
         %{subject: subject, network: network, master: master, a: a} do
      [first, second] = otks(a, 2)
      fb = fallback(a)
      {:ok, _} = upload(a, [first, second], fb)
      listed(subject, network, master, [a], 1)

      {:ok, payload, keys} = E2eKeys.answer(subject, network.id, :otk)
      assert [%{"otk" => %{"key" => key}}] = decode!(payload)["devices"]
      assert key == first.key
      # Not consumed yet: asked again, the same answer.
      assert {:ok, ^payload, ^keys} = E2eKeys.answer(subject, network.id, :otk)
      assert :ok = E2eKeys.consume(keys)
      assert {:error, :gone} = E2eKeys.consume(keys)

      {:ok, next, next_keys} = E2eKeys.answer(subject, network.id, :otk)
      assert [%{"otk" => %{"key" => next_key}}] = decode!(next)["devices"]
      assert next_key == second.key
      :ok = E2eKeys.consume(next_keys)

      # Then the fallback key, again and again.
      for _ <- 1..2 do
        {:ok, payload, keys} = E2eKeys.answer(subject, network.id, :otk)
        assert [%{"otk" => %{"key" => key, "fallback" => true}}] = decode!(payload)["devices"]
        assert key == fb.key
        assert :ok = E2eKeys.consume(keys)
      end

      assert E2eKeys.status(a.device) == %{one_time_keys: 0, fallback: true}
    end

    test "asked for fallback keys, it hands out no one-time key, and skips a device without a fallback key",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(a, otks(a, 1), nil)
      {:ok, _} = upload(b, otks(b, 1), fallback(b))
      listed(subject, network, master, [a, b], 1)

      {:ok, payload, [%Key{kind: :fallback}] = keys} = E2eKeys.answer(subject, network.id, :fallback)
      assert [%{"id" => %{"ed25519" => ed25519}, "otk" => %{"fallback" => true}}] = decode!(payload)["devices"]
      assert ed25519 == b.device.ed25519
      :ok = E2eKeys.consume(keys)
      assert E2eKeys.status(a.device).one_time_keys == 1
    end

    test "a device registered but not listed is never in the answer; a revoked one goes with its keys",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(a, otks(a, 1), fallback(a))
      {:ok, _} = upload(b, otks(b, 1), fallback(b))
      listed(subject, network, master, [a], 1)

      {:ok, payload, _} = E2eKeys.answer(subject, network.id, :otk)
      assert [%{"id" => %{"ed25519" => only}}] = decode!(payload)["devices"]
      assert only == a.device.ed25519

      listed(subject, network, master, [a, b], 2)
      listed(subject, network, master, [b], 3)

      {:ok, after_revoke, _} = E2eKeys.answer(subject, network.id, :otk)
      assert [%{"id" => %{"ed25519" => left}}] = decode!(after_revoke)["devices"]
      assert left == b.device.ed25519
      assert Repo.aggregate(where(Key, [k], k.device_id == ^a.device.id), :count) == 0
    end

    test "consume is all or nothing: one key gone, and none of the others is spent",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(a, otks(a, 1), nil)
      {:ok, _} = upload(b, [], fallback(b))
      listed(subject, network, master, [a, b], 1)
      {:ok, _, keys} = E2eKeys.answer(subject, network.id, :otk)

      # The client replaced b's fallback key after the answer was picked.
      {:ok, _} = upload(b, [], fallback(b))

      assert {:error, :gone} = E2eKeys.consume(keys)
      assert E2eKeys.status(a.device).one_time_keys == 1
    end

    test "another subject's identity on the same network is not in the answer",
         %{subject: subject, network: network, master: master, a: a} do
      {:ok, _} = upload(a, otks(a, 1), nil)
      listed(subject, network, master, [a], 1)

      other = {:user, user_fixture().id}
      assert {:error, :empty} = E2eKeys.answer(other, network.id, :otk)
      assert {:error, :empty} = E2eKeys.answer(subject, network_fixture().id, :otk)
    end
  end

  describe "claim/4" do
    setup %{subject: subject, network: network, master: master} do
      a = device(subject, network, master)
      b = device(subject, network, master)
      {:ok, a: a, b: b}
    end

    test "returns the sibling's block in the KEYS shape and consumes its one-time key",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      [first, second] = otks(b, 2)
      {:ok, _} = upload(b, [first, second], nil)
      {:ok, list} = listed(subject, network, master, [a, b], 1)

      assert {:ok, payload} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
      refute payload =~ " "

      assert %{"v" => 2, "master" => master_block, "devices" => [entry]} = decode!(payload)

      assert master_block == %{
               "ed25519" => master.public,
               "list" => %{"ver" => 1, "devices" => list.devices},
               "sig" => list.sig
             }

      assert entry == %{
               "id" => %{"curve25519" => b.device.curve25519, "ed25519" => b.device.ed25519, "sig" => b.device.sig},
               "otk" => %{"key" => first.key, "fallback" => false, "sig" => first.sig}
             }

      assert E2eKeys.status(b.device).one_time_keys == 1

      {:ok, next} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
      assert [%{"otk" => %{"key" => key}}] = decode!(next)["devices"]
      assert key == second.key
    end

    test "hands the fallback key once the one-time keys are gone, and keeps it",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      [only] = otks(b, 1)
      fb = fallback(b)
      {:ok, _} = upload(b, [only], fb)
      listed(subject, network, master, [a, b], 1)

      assert {:ok, _} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)

      for _ <- 1..2 do
        {:ok, payload} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
        assert [%{"otk" => %{"key" => key, "fallback" => true}}] = decode!(payload)["devices"]
        assert key == fb.key
      end

      assert E2eKeys.status(b.device) == %{one_time_keys: 0, fallback: true}
    end

    test "refuses the caller's own did, and a sibling holding no key at all",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(a, otks(a, 1), nil)
      listed(subject, network, master, [a, b], 1)

      assert {:error, :self} = E2eKeys.claim(subject, network.id, a.device.did, a.device.did)
      assert {:error, :empty} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
      assert E2eKeys.status(a.device).one_time_keys == 1
    end

    test "is scoped to the subject: a stranger's device, or an unlisted one, is not found",
         %{subject: subject, network: network, master: master, a: a, b: b} do
      listed(subject, network, master, [a], 1)
      {:ok, _} = upload(b, otks(b, 1), nil)

      other = {:user, user_fixture().id}
      other_master = E2eFixtures.identity()
      theirs = device(other, network, other_master)
      {:ok, _} = upload(theirs, otks(theirs, 1), nil)
      listed(other, network, other_master, [theirs], 1)

      assert {:error, :not_found} = E2eKeys.claim(subject, network.id, a.device.did, theirs.device.did)
      assert {:error, :not_found} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
      assert E2eKeys.status(theirs.device).one_time_keys == 1
    end

    test "the caller must be a listed device itself", %{subject: subject, network: network, master: master, a: a, b: b} do
      {:ok, _} = upload(b, otks(b, 1), nil)
      listed(subject, network, master, [b], 1)

      assert {:error, :unknown_device} = E2eKeys.claim(subject, network.id, a.device.did, b.device.did)
      assert E2eKeys.status(b.device).one_time_keys == 1
    end
  end

  describe "duplicates" do
    setup %{subject: subject, network: network, master: master} do
      {:ok, dev: device(subject, network, master)}
    end

    test "a one-time key uploaded twice is held once, so a retried upload hands no key out twice", %{dev: dev} do
      [a, b] = otks(dev, 2)

      assert {:ok, %{one_time_keys: 2}} = upload(dev, [a, b, a], nil)
      # The client never saw the answer and sends the same batch again.
      assert {:ok, %{one_time_keys: 2}} = upload(dev, [a, b], nil)
    end

    test "a retried batch does not count against the bound twice", %{dev: dev} do
      batch = otks(dev, E2eKeys.max_one_time_keys())
      {:ok, %{one_time_keys: 50}} = upload(dev, batch, nil)
      assert {:ok, %{one_time_keys: 50}} = upload(dev, batch, nil)
    end

    test "the table itself holds one fallback key per device", %{dev: dev} do
      insert = fn ->
        Repo.insert(Key.changeset(%Key{}, Map.merge(fallback(dev), %{device_id: dev.device.id, kind: :fallback})))
      end

      assert {:ok, _} = insert.()
      assert {:error, %Ecto.Changeset{errors: [kind: _]}} = insert.()
    end
  end

  describe "clear/2" do
    test "drops that subject's devices, their keys and its list on that network, and nothing else",
         %{subject: subject, network: network, master: master} do
      dev = device(subject, network, master)
      {:ok, _} = upload(dev, otks(dev, 2), fallback(dev))
      listed(subject, network, master, [dev], 1)
      {:ok, _, picked} = E2eKeys.answer(subject, network.id, :otk)

      other = {:user, user_fixture().id}
      theirs = device(other, network, master)
      {:ok, _} = upload(theirs, otks(theirs, 1), nil)

      assert :ok = E2eKeys.clear(subject, network.id)
      assert E2eKeys.devices(subject, network.id) == []
      assert {:error, :not_found} = E2eKeys.list(subject, network.id)
      assert E2eKeys.status(theirs.device).one_time_keys == 1
      # A key picked before the clear is not handed out after it.
      assert {:error, :gone} = E2eKeys.consume(picked)

      # The account starts over under a new master, whose first list is taken.
      new_master = E2eFixtures.identity()
      fresh = device(subject, network, new_master)
      assert {:ok, %DeviceList{ver: 1}} = listed(subject, network, new_master, [fresh], 1)
    end
  end

  describe "register_device/3 and devices/2 (multi-device)" do
    setup do
      {:ok, master: E2eFixtures.identity()}
    end

    test "registers a device under the did derived from its Ed25519 key",
         %{subject: subject, network: network, master: master} do
      %{attrs: attrs} = E2eFixtures.device(master)
      {:ok, did} = Device.did(attrs.ed25519)

      assert {:ok, %Device{did: ^did} = device} = E2eKeys.register_device(subject, network.id, attrs)
      assert device.curve25519 == attrs.curve25519
      assert device.sig == attrs.sig
      assert [%Device{did: ^did}] = E2eKeys.devices(subject, network.id)
      assert {:ok, %Device{did: ^did}} = E2eKeys.device(subject, network.id, did)
    end

    test "a device registering again replaces its id block, and stays one device",
         %{subject: subject, network: network, master: master} do
      %{identity: identity, attrs: attrs} = E2eFixtures.device(master)
      {:ok, _} = E2eKeys.register_device(subject, network.id, attrs)

      # The same device signing its id block over a new master (an
      # identity reset on another device, then a re-pair).
      new_master = E2eFixtures.identity()
      sig = E2eFixtures.sign(identity, "irc-e2e:v2:id:#{attrs.curve25519}:#{new_master.public}")

      assert {:ok, %Device{sig: ^sig}} = E2eKeys.register_device(subject, network.id, %{attrs | sig: sig})
      assert [%Device{sig: ^sig}] = E2eKeys.devices(subject, network.id)
    end

    test "holds at most 4 devices per (subject, network); a fifth is refused",
         %{subject: subject, network: network, master: master} do
      for _ <- 1..DeviceList.max_devices() do
        assert {:ok, _} = E2eKeys.register_device(subject, network.id, E2eFixtures.device(master).attrs)
      end

      assert {:error, :too_many_devices} =
               E2eKeys.register_device(subject, network.id, E2eFixtures.device(master).attrs)

      assert length(E2eKeys.devices(subject, network.id)) == 4

      # Another subject, or another network, has room of its own.
      other = {:user, user_fixture().id}
      assert {:ok, _} = E2eKeys.register_device(other, network.id, E2eFixtures.device(master).attrs)
      assert {:ok, _} = E2eKeys.register_device(subject, network_fixture().id, E2eFixtures.device(master).attrs)
    end

    test "a full partition still takes a device that is already there",
         %{subject: subject, network: network, master: master} do
      [%{attrs: first} | _] =
        for _ <- 1..DeviceList.max_devices() do
          device = E2eFixtures.device(master)
          {:ok, _} = E2eKeys.register_device(subject, network.id, device.attrs)
          device
        end

      assert {:ok, _} = E2eKeys.register_device(subject, network.id, first)
    end

    test "refuses an id block that is not keys and a signature, and stores nothing",
         %{subject: subject, network: network, master: master} do
      %{attrs: attrs} = E2eFixtures.device(master)

      for bad <- [
            %{attrs | ed25519: "not a key"},
            %{attrs | curve25519: attrs.curve25519 <> "="},
            %{attrs | sig: attrs.ed25519},
            Map.delete(attrs, :sig)
          ] do
        assert {:error, :bad_request} = E2eKeys.register_device(subject, network.id, bad)
      end

      assert E2eKeys.devices(subject, network.id) == []
    end

    test "device/3 finds only this subject's device on this network",
         %{subject: subject, network: network, master: master} do
      %{attrs: attrs} = E2eFixtures.device(master)
      {:ok, %Device{did: did}} = E2eKeys.register_device(subject, network.id, attrs)

      assert {:error, :not_found} = E2eKeys.device({:user, user_fixture().id}, network.id, did)
      assert {:error, :not_found} = E2eKeys.device(subject, network_fixture().id, did)
      assert {:error, :not_found} = E2eKeys.device(subject, network.id, "AAAAAAAAAAA")
    end
  end

  describe "put_list/3 and list/2 (multi-device)" do
    setup %{subject: subject, network: network} do
      master = E2eFixtures.identity()

      keys =
        for _ <- 1..3 do
          %{attrs: attrs} = E2eFixtures.device(master)
          {:ok, _} = E2eKeys.register_device(subject, network.id, attrs)
          attrs.ed25519
        end

      {:ok, master: master, keys: keys}
    end

    test "stores a list of registered devices signed by the master",
         %{subject: subject, network: network, master: master, keys: keys} do
      attrs = E2eFixtures.list(master, 1, keys)

      assert {:ok, %DeviceList{ver: 1} = list} = E2eKeys.put_list(subject, network.id, attrs)
      assert list.master == master.public
      assert list.devices == attrs.devices
      assert list.sig == attrs.sig
      assert {:ok, %DeviceList{ver: 1}} = E2eKeys.list(subject, network.id)
    end

    test "a list that does not verify, or is malformed, is refused and nothing is stored",
         %{subject: subject, network: network, master: master, keys: [a, b, c]} do
      good = E2eFixtures.list(master, 1, [a, b])
      [low, high] = good.devices

      for bad <- [
            # Signed by someone else, or over another list.
            Map.put(E2eFixtures.list(E2eFixtures.identity(), 1, [a, b]), :master, master.public),
            %{good | ver: 2},
            %{good | devices: Enum.sort([low, high, c])},
            # Well signed but unsorted, duplicated, empty, too long.
            %{E2eFixtures.list(master, 1, [a, b]) | devices: [high, low]},
            Map.put(E2eFixtures.list(master, 1, [a]), :devices, [a, a]),
            %{good | devices: []},
            %{good | ver: 0},
            %{good | ver: 2_147_483_648},
            %{good | master: "not a key"},
            Map.delete(good, :sig)
          ] do
        assert {:error, :bad_request} = E2eKeys.put_list(subject, network.id, bad)
      end

      assert {:error, :not_found} = E2eKeys.list(subject, network.id)
    end

    test "more than 4 devices is refused even when signed", %{subject: subject, network: network, master: master} do
      keys = for _ <- 1..5, do: E2eFixtures.identity().public
      assert {:error, :bad_request} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 1, keys))
    end

    test "the version must rise, under the same master",
         %{subject: subject, network: network, master: master, keys: [a, b | _]} do
      {:ok, _} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 3, [a]))

      assert {:error, :stale_list} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 3, [a, b]))
      assert {:error, :stale_list} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 2, [a, b]))

      assert {:error, :master_mismatch} =
               E2eKeys.put_list(subject, network.id, E2eFixtures.list(E2eFixtures.identity(), 4, [a, b]))

      assert {:ok, %DeviceList{ver: 4}} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 4, [a, b]))
    end

    test "a key no device registered is refused", %{subject: subject, network: network, master: master, keys: [a | _]} do
      stranger = E2eFixtures.identity().public

      assert {:error, :unknown_device} =
               E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 1, [a, stranger]))

      # Another subject's device is a stranger here too.
      other = {:user, user_fixture().id}
      %{attrs: theirs} = E2eFixtures.device(master)
      {:ok, _} = E2eKeys.register_device(other, network.id, theirs)

      assert {:error, :unknown_device} =
               E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 1, [a, theirs.ed25519]))
    end

    test "a device the new list drops is revoked: its row goes, with its queue; a device never listed stays",
         %{subject: subject, network: network, master: master, keys: [a, b, pending]} do
      {:ok, _} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 1, [a, b]))
      revoked = subject |> E2eKeys.devices(network.id) |> Enum.find(&(&1.ed25519 == b))
      {:ok, _} = E2eInbox.put(revoked, inbox_message())
      {:ok, _} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 2, [a]))

      assert subject |> E2eKeys.devices(network.id) |> Enum.map(& &1.ed25519) |> Enum.sort() == Enum.sort([a, pending])
      assert Repo.aggregate(where(Entry, [e], e.device_id == ^revoked.id), :count) == 0
    end

    test "the very list held, put again, is answered as the first time and changes nothing",
         %{subject: subject, network: network, master: master, keys: [a, b | _]} do
      attrs = E2eFixtures.list(master, 2, [a, b])
      {:ok, first} = E2eKeys.put_list(subject, network.id, attrs)

      assert {:ok, %DeviceList{id: id, ver: 2, devices: devices, sig: sig}} =
               E2eKeys.put_list(subject, network.id, attrs)

      assert {id, devices, sig} == {first.id, first.devices, first.sig}

      # The same version naming other devices is still stale.
      assert {:error, :stale_list} = E2eKeys.put_list(subject, network.id, E2eFixtures.list(master, 2, [a]))
      assert {:ok, %DeviceList{devices: ^devices}} = E2eKeys.list(subject, network.id)
    end
  end

  describe "remove_device/3" do
    test "drops a device the list does not name, with its keys and queue; a listed one is refused",
         %{subject: subject, network: network, master: master} do
      kept = device(subject, network, master)
      pairing = device(subject, network, master)
      listed(subject, network, master, [kept], 1)
      {:ok, _} = upload(pairing, otks(pairing, 1), fallback(pairing))
      {:ok, _} = E2eInbox.put(pairing.device, inbox_message())

      assert {:error, :listed_device} = E2eKeys.remove_device(subject, network.id, kept.device.did)
      assert :ok = E2eKeys.remove_device(subject, network.id, pairing.device.did)
      assert {:error, :not_found} = E2eKeys.remove_device(subject, network.id, pairing.device.did)

      assert Enum.map(E2eKeys.devices(subject, network.id), & &1.did) == [kept.device.did]
      assert Repo.aggregate(where(Key, [k], k.device_id == ^pairing.device.id), :count) == 0
      assert Repo.aggregate(where(Entry, [e], e.device_id == ^pairing.device.id), :count) == 0
    end

    test "before any list, every device is unlisted; another subject's device is not found",
         %{subject: subject, network: network, master: master} do
      mine = device(subject, network, master)
      other = {:user, user_fixture().id}
      theirs = device(other, network, master)

      assert {:error, :not_found} = E2eKeys.remove_device(subject, network.id, theirs.device.did)
      assert [_] = E2eKeys.devices(other, network.id)
      assert :ok = E2eKeys.remove_device(subject, network.id, mine.device.did)
      assert E2eKeys.devices(subject, network.id) == []
    end
  end
end
