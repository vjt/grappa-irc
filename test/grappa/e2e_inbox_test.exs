defmodule Grappa.E2eInboxTest do
  @moduledoc """
  issue 2430 — the offline queue for end-to-end encrypted messages, one per
  device (multi-device, wire v2): what a peer sent a device waits here,
  ciphertext only, until that device takes it and acknowledges it, or
  until it expires.

  Every test reads the table through the context, so a test passing here
  says what a caller sees, not what a column holds.
  """
  use Grappa.DataCase, async: true

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{E2eFixtures, E2eInbox, E2eKeys, Repo}
  alias Grappa.E2eInbox.Entry
  alias Grappa.E2eKeys.Device
  alias Grappa.IRC.E2e

  # The sending device, as the frame named it.
  @from "If4x36FUomE"

  defp message(sender, verb), do: message(sender, verb, ~s({"v":2}))

  defp message(sender, verb, payload),
    do: %{sender: sender, from_did: @from, verb: verb, msgid: "q83vEjRWeJA", payload: payload}

  defp put!(device, attrs) do
    {:ok, entry} = E2eInbox.put(device, attrs)
    entry
  end

  defp device!(subject, network) do
    {:ok, %Device{} = device} =
      E2eKeys.register_device(subject, network.id, E2eFixtures.device(E2eFixtures.identity()).attrs)

    device
  end

  # The queue keeps a row's age in `inserted_at`; a test that needs an old
  # row moves that one column and nothing else.
  defp age!(%Entry{id: id}, seconds) do
    at = DateTime.truncate(DateTime.add(DateTime.utc_now(), -seconds, :second), :second)
    {1, _} = Entry |> where([e], e.id == ^id) |> Repo.update_all(set: [inserted_at: at])
    :ok
  end

  # A payload whose row costs exactly `bytes` against the caps.
  defp payload_costing(bytes), do: String.duplicate("A", bytes - E2eInbox.row_overhead_bytes())

  # Rows from `sender` (own copies when `own?`) costing `bytes` in all: as many full-size messages as
  # fit, then one for the rest (which must be more than a row's overhead).
  defp fill!(device, sender, own?, bytes) do
    full = E2e.max_payload_bytes() + E2eInbox.row_overhead_bytes()
    rest = rem(bytes, full)
    true = rest == 0 or rest > E2eInbox.row_overhead_bytes()

    sizes = List.duplicate(full, div(bytes, full)) ++ if(rest > 0, do: [rest], else: [])
    Enum.each(sizes, &put!(device, Map.put(message(sender, :msg, payload_costing(&1)), :own, own?)))
  end

  defp own_message(sender, payload), do: Map.put(message(sender, :msg, payload), :own, true)

  setup do
    user = user_fixture()
    subject = {:user, user.id}
    network = network_fixture()
    {:ok, subject: subject, network: network, device: device!(subject, network), other: device!(subject, network)}
  end

  describe "put/2 and list/2" do
    test "a device dropped since the caller read it takes nothing: :gone, not a raise",
         %{subject: subject, network: network, device: device} do
      # SQLite names no constraint for the foreign key, so only the check
      # inside the transaction can tell this apart.
      :ok = E2eKeys.clear(subject, network.id)
      assert {:error, :gone} = E2eInbox.put(device, message("alice", :msg))
    end

    test "an entry comes back whole, in arrival order", %{device: device} do
      first = put!(device, message("Alice", :pkmsg, ~s({"a":1})))
      second = put!(device, %{message("bob", :keys, ~s({"b":2})) | from_did: "*"})

      assert [a, b] = E2eInbox.list(device, 0)
      assert a.id == first.id and b.id == second.id
      assert {a.sender, a.from_did, a.verb, a.msgid, a.payload} == {"Alice", @from, :pkmsg, "q83vEjRWeJA", ~s({"a":1})}
      assert {b.sender, b.from_did, b.verb, b.payload} == {"bob", "*", :keys, ~s({"b":2})}
      assert first.id < second.id
    end

    test "a device sees only its own entries: not its sibling's, not another subject's",
         %{device: device, other: other, network: network} do
      mine = put!(device, message("alice", :msg))
      _ = put!(other, message("alice", :msg))
      _ = put!(device!({:user, user_fixture().id}, network), message("alice", :msg))

      assert [%Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == mine.id
    end

    test "a visitor's device has a queue of its own", %{network: network} do
      device = device!({:visitor, visitor_fixture().id}, network)
      entry = put!(device, message("alice", :keys))

      assert [%Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == entry.id
    end

    test "list pages past a cursor, at most a page at a time", %{device: device} do
      entries = for _ <- 1..(E2eInbox.page_size() + 2), do: put!(device, message("alice", :msg))
      ids = Enum.map(entries, & &1.id)

      page = E2eInbox.list(device, 0)
      assert Enum.map(page, & &1.id) == Enum.take(ids, E2eInbox.page_size())

      rest = E2eInbox.list(device, List.last(page).id)
      assert Enum.map(rest, & &1.id) == Enum.drop(ids, E2eInbox.page_size())
    end

    test "a verb outside the four a client is handed, or a from that is no device, is refused",
         %{device: device} do
      assert {:error, %Ecto.Changeset{}} = E2eInbox.put(device, message("alice", :keyreq))
      assert {:error, %Ecto.Changeset{}} = E2eInbox.put(device, %{message("alice", :msg) | from_did: "not a did"})
      assert E2eInbox.list(device, 0) == []
    end

    test "a device that goes takes its queue with it", %{subject: subject, network: network, device: device} do
      _ = put!(device, message("alice", :msg))
      :ok = E2eKeys.clear(subject, network.id)
      assert Repo.aggregate(Entry, :count) == 0
    end
  end

  describe "caps" do
    test "one sender cannot hold more than its share; another sender still gets in", %{device: device} do
      fill!(device, "Alice", false, E2eInbox.max_sender_bytes() - 1_000)

      # 1 000 bytes left in alice's share: a row costing 1 000 fits, the next
      # one does not — whatever case the nick arrives in. The share is
      # filled under a spelling neither later message uses, so the fold has
      # to hold on the STORED side too, not only on the arriving one.
      _ = put!(device, message("alice", :msg, payload_costing(1_000)))
      assert {:error, :full} = E2eInbox.put(device, message("ALICE", :msg, payload_costing(300)))

      assert {:ok, _} = E2eInbox.put(device, message("bob", :msg, payload_costing(300)))
    end

    test "the whole queue has a ceiling across senders", %{device: device} do
      share = E2eInbox.max_sender_bytes()
      senders = div(E2eInbox.max_bytes(), share)

      for n <- 1..senders, do: fill!(device, "peer#{n}", false, share)

      assert {:error, :full} = E2eInbox.put(device, message("late", :msg, payload_costing(300)))
    end

    test "a device's full queue leaves its sibling's untouched", %{device: device, other: other} do
      fill!(device, "alice", false, E2eInbox.max_sender_bytes())
      assert {:error, :full} = E2eInbox.put(device, message("alice", :msg, payload_costing(300)))

      assert {:ok, _} = E2eInbox.put(other, message("alice", :msg, payload_costing(300)))
    end

    test "own copies share one 1 MiB sender bound however the nick is spelled", %{device: device} do
      full = E2e.max_payload_bytes() + E2eInbox.row_overhead_bytes()
      share = E2eInbox.max_sender_bytes()

      # Alternate spellings until less than a full row is left in the share.
      for n <- 1..div(share, full) do
        assert {:ok, _} =
                 E2eInbox.put(device, own_message(if(rem(n, 2) == 0, do: "vjt", else: "VJT2"), payload_costing(full)))
      end

      rest = rem(share, full)
      assert {:error, :full} = E2eInbox.put(device, own_message("vjt", payload_costing(rest + 1)))
      assert {:ok, _} = E2eInbox.put(device, own_message("VJT2", payload_costing(rest)))
      assert {:error, :full} = E2eInbox.put(device, own_message("vjt", payload_costing(300)))
    end

    test "own copies do not consume a peer's sender share", %{device: device} do
      fill!(device, "vjt", true, E2eInbox.max_sender_bytes())
      assert {:error, :full} = E2eInbox.put(device, own_message("vjt", payload_costing(300)))

      assert {:ok, _} = E2eInbox.put(device, message("alice", :msg, payload_costing(300)))
    end

    test "a peer at its share does not block own copies", %{device: device} do
      fill!(device, "alice", false, E2eInbox.max_sender_bytes())
      assert {:error, :full} = E2eInbox.put(device, message("alice", :msg, payload_costing(300)))

      assert {:ok, _} = E2eInbox.put(device, own_message("vjt", payload_costing(300)))
    end

    test "own and peer rows together are capped at 4 MiB", %{device: device} do
      share = E2eInbox.max_sender_bytes()
      peers = div(E2eInbox.max_bytes(), share) - 1

      for n <- 1..peers, do: fill!(device, "peer#{n}", false, share)
      fill!(device, "vjt", true, share)

      assert {:error, :full} = E2eInbox.put(device, message("late", :msg, payload_costing(300)))
      assert {:error, :full} = E2eInbox.put(device, own_message("vjt", payload_costing(300)))
    end
  end

  describe "ack/2" do
    test "deletes the acknowledged entries and nothing else", %{device: device} do
      a = put!(device, message("alice", :msg))
      b = put!(device, message("alice", :msg))

      assert :ok = E2eInbox.ack(device, [a.id])
      assert [%Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == b.id
      # Again, and an id that was never there: nothing to do, no error.
      assert :ok = E2eInbox.ack(device, [a.id, b.id + 1_000])
    end

    test "one device acknowledging never takes a message from another", %{device: device, other: other} do
      theirs = put!(other, message("alice", :msg))

      assert :ok = E2eInbox.ack(device, [theirs.id])
      assert [%Entry{}] = E2eInbox.list(other, 0)
    end

    test "an id is never handed out twice, even after the newest entry is gone", %{device: device} do
      # A client tells a redelivery from a new message by its id. SQLite's
      # plain rowid hands the newest id out again once that row is deleted,
      # which would make the next message look like one already read.
      first = put!(device, message("alice", :msg))
      :ok = E2eInbox.ack(device, [first.id])
      second = put!(device, message("alice", :msg))

      assert second.id > first.id
    end
  end

  describe "expire/3" do
    test "drops what is older than the cutoff and counts it per sender and device",
         %{subject: subject, network: network, device: device, other: other} do
      old_a = put!(device, message("alice", :msg))
      old_b = put!(device, message("Alice", :pkmsg))
      old_c = put!(device, message("bob", :msg))
      old_d = put!(other, message("alice", :msg))
      fresh = put!(device, message("alice", :msg))
      Enum.each([old_a, old_b, old_c, old_d], &age!(&1, 120))

      cutoff = DateTime.add(DateTime.utc_now(), -60, :second)
      assert {:ok, expired} = E2eInbox.expire(subject, network.id, cutoff)

      # One count per person and device, under the spelling they used last.
      assert Enum.sort(expired) ==
               Enum.sort([{"Alice", device.did, 2}, {"bob", device.did, 1}, {"alice", other.did, 1}])

      assert [%Entry{id: id}] = E2eInbox.list(device, 0)
      assert id == fresh.id
      assert E2eInbox.list(other, 0) == []
    end

    test "key exchange and NACKs expire without being counted as messages",
         %{subject: subject, network: network, device: device} do
      keys = put!(device, message("alice", :keys))
      nack = put!(device, message("alice", :nack))
      Enum.each([keys, nack], &age!(&1, 120))

      assert {:ok, []} = E2eInbox.expire(subject, network.id, DateTime.utc_now())
      assert E2eInbox.list(device, 0) == []
    end

    test "expire/3 deletes own rows but does not report them",
         %{subject: subject, network: network, device: device} do
      mine = put!(device, own_message("vjt", ~s({"v":2})))
      theirs = put!(device, message("alice", :msg))
      Enum.each([mine, theirs], &age!(&1, 120))

      assert {:ok, [{"alice", did, 1}]} = E2eInbox.expire(subject, network.id, DateTime.utc_now())
      assert did == device.did
      assert E2eInbox.list(device, 0) == []
    end

    test "touches only the subject and network asked for", %{subject: subject, network: network} do
      theirs_device = device!({:user, user_fixture().id}, network)
      elsewhere = device!(subject, network_fixture())
      theirs = put!(theirs_device, message("alice", :msg))
      mine_elsewhere = put!(elsewhere, message("alice", :msg))
      Enum.each([theirs, mine_elsewhere], &age!(&1, 120))

      assert {:ok, []} = E2eInbox.expire(subject, network.id, DateTime.utc_now())
      assert [%Entry{}] = E2eInbox.list(theirs_device, 0)
      assert [%Entry{}] = E2eInbox.list(elsewhere, 0)
    end
  end
end
