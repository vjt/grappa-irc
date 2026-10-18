defmodule Grappa.E2eInboxTest do
  @moduledoc """
  issue 2430 — the offline queue for end-to-end encrypted messages: what a
  peer sent us waits here, ciphertext only, until a client takes it and
  acknowledges it, or until it expires.

  Every test reads the table through the context, so a test passing here
  says what a caller sees, not what a column holds.
  """
  use Grappa.DataCase, async: true

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{E2eInbox, Repo}
  alias Grappa.E2eInbox.Entry
  alias Grappa.IRC.E2e

  defp message(sender, verb), do: message(sender, verb, "eyJ2IjoxfQ")
  defp message(sender, verb, payload), do: %{sender: sender, verb: verb, msgid: "q83vEjRWeJA", payload: payload}

  defp put!(subject, network_id, attrs) do
    {:ok, entry} = E2eInbox.put(subject, network_id, attrs)
    entry
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

  # Rows from `sender` costing `bytes` in all: as many full-size messages as
  # fit, then one for the rest (which must be more than a row's overhead).
  defp fill!(subject, network_id, sender, bytes) do
    full = E2e.max_payload_bytes() + E2eInbox.row_overhead_bytes()
    rest = rem(bytes, full)
    true = rest == 0 or rest > E2eInbox.row_overhead_bytes()

    sizes = List.duplicate(full, div(bytes, full)) ++ if(rest > 0, do: [rest], else: [])
    Enum.each(sizes, &put!(subject, network_id, message(sender, :msg, payload_costing(&1))))
  end

  setup do
    user = user_fixture()
    {:ok, user: user, subject: {:user, user.id}, network: network_fixture()}
  end

  describe "put/3 and list/3" do
    test "an entry comes back whole, in arrival order", %{subject: subject, network: network} do
      first = put!(subject, network.id, message("Alice", :pkmsg, "Zmlyc3Q"))
      second = put!(subject, network.id, message("bob", :msg, "c2Vjb25k"))

      assert [a, b] = E2eInbox.list(subject, network.id, 0)
      assert a.id == first.id and b.id == second.id
      assert {a.sender, a.verb, a.msgid, a.payload} == {"Alice", :pkmsg, "q83vEjRWeJA", "Zmlyc3Q"}
      assert {b.sender, b.verb, b.payload} == {"bob", :msg, "c2Vjb25k"}
      assert first.id < second.id
    end

    test "a subject sees only its own entries, on the network asked for", %{subject: subject, network: network} do
      other_user = user_fixture()
      other_network = network_fixture()
      mine = put!(subject, network.id, message("alice", :msg))
      _ = put!({:user, other_user.id}, network.id, message("alice", :msg))
      _ = put!(subject, other_network.id, message("alice", :msg))

      assert [%Entry{id: id}] = E2eInbox.list(subject, network.id, 0)
      assert id == mine.id
    end

    test "a visitor has a queue of its own", %{network: network} do
      visitor = visitor_fixture()
      entry = put!({:visitor, visitor.id}, network.id, message("alice", :keys))

      assert [%Entry{id: id}] = E2eInbox.list({:visitor, visitor.id}, network.id, 0)
      assert id == entry.id
    end

    test "list pages past a cursor, at most a page at a time", %{subject: subject, network: network} do
      entries = for _ <- 1..(E2eInbox.page_size() + 2), do: put!(subject, network.id, message("alice", :msg))
      ids = Enum.map(entries, & &1.id)

      page = E2eInbox.list(subject, network.id, 0)
      assert Enum.map(page, & &1.id) == Enum.take(ids, E2eInbox.page_size())

      rest = E2eInbox.list(subject, network.id, List.last(page).id)
      assert Enum.map(rest, & &1.id) == Enum.drop(ids, E2eInbox.page_size())
    end

    test "a verb outside the four a client is handed is refused", %{subject: subject, network: network} do
      assert {:error, %Ecto.Changeset{}} = E2eInbox.put(subject, network.id, message("alice", :keyreq))
      assert E2eInbox.list(subject, network.id, 0) == []
    end
  end

  describe "caps" do
    test "one sender cannot hold more than its share; another sender still gets in",
         %{subject: subject, network: network} do
      fill!(subject, network.id, "Alice", E2eInbox.max_sender_bytes() - 1_000)

      # 1 000 bytes left in alice's share: a row costing 1 000 fits, the next
      # one does not — whatever case the nick arrives in. The share is
      # filled under a spelling neither later message uses, so the fold has
      # to hold on the STORED side too, not only on the arriving one.
      _ = put!(subject, network.id, message("alice", :msg, payload_costing(1_000)))
      assert {:error, :full} = E2eInbox.put(subject, network.id, message("ALICE", :msg, payload_costing(300)))

      assert {:ok, _} = E2eInbox.put(subject, network.id, message("bob", :msg, payload_costing(300)))
    end

    test "the whole queue has a ceiling across senders", %{subject: subject, network: network} do
      share = E2eInbox.max_sender_bytes()
      senders = div(E2eInbox.max_bytes(), share)

      for n <- 1..senders, do: fill!(subject, network.id, "peer#{n}", share)

      assert {:error, :full} = E2eInbox.put(subject, network.id, message("late", :msg, payload_costing(300)))
    end

    test "a subject's full queue leaves another subject's untouched", %{subject: subject, network: network} do
      fill!(subject, network.id, "alice", E2eInbox.max_sender_bytes())
      assert {:error, :full} = E2eInbox.put(subject, network.id, message("alice", :msg, payload_costing(300)))
      other = user_fixture()

      assert {:ok, _} = E2eInbox.put({:user, other.id}, network.id, message("alice", :msg, payload_costing(300)))
    end
  end

  describe "ack/3" do
    test "deletes the acknowledged entries and nothing else", %{subject: subject, network: network} do
      a = put!(subject, network.id, message("alice", :msg))
      b = put!(subject, network.id, message("alice", :msg))

      assert :ok = E2eInbox.ack(subject, network.id, [a.id])
      assert [%Entry{id: id}] = E2eInbox.list(subject, network.id, 0)
      assert id == b.id
      # Again, and an id that was never there: nothing to do, no error.
      assert :ok = E2eInbox.ack(subject, network.id, [a.id, b.id + 1_000])
    end

    test "cannot delete another subject's entries", %{subject: subject, network: network} do
      other = user_fixture()
      theirs = put!({:user, other.id}, network.id, message("alice", :msg))

      assert :ok = E2eInbox.ack(subject, network.id, [theirs.id])
      assert [%Entry{}] = E2eInbox.list({:user, other.id}, network.id, 0)
    end

    test "an id is never handed out twice, even after the newest entry is gone",
         %{subject: subject, network: network} do
      # A client tells a redelivery from a new message by its id. SQLite's
      # plain rowid hands the newest id out again once that row is deleted,
      # which would make the next message look like one already read.
      first = put!(subject, network.id, message("alice", :msg))
      :ok = E2eInbox.ack(subject, network.id, [first.id])
      second = put!(subject, network.id, message("alice", :msg))

      assert second.id > first.id
    end
  end

  describe "expire/3" do
    test "drops what is older than the cutoff and counts it per sender", %{subject: subject, network: network} do
      old_a = put!(subject, network.id, message("alice", :msg))
      old_b = put!(subject, network.id, message("Alice", :pkmsg))
      old_c = put!(subject, network.id, message("bob", :msg))
      fresh = put!(subject, network.id, message("alice", :msg))
      Enum.each([old_a, old_b, old_c], &age!(&1, 120))

      cutoff = DateTime.add(DateTime.utc_now(), -60, :second)
      assert {:ok, expired} = E2eInbox.expire(subject, network.id, cutoff)

      # One count per person, under the spelling they used last.
      assert Enum.sort(expired) == [{"Alice", 2}, {"bob", 1}]
      assert [%Entry{id: id}] = E2eInbox.list(subject, network.id, 0)
      assert id == fresh.id
    end

    test "key exchange and NACKs expire without being counted as messages", %{subject: subject, network: network} do
      keys = put!(subject, network.id, message("alice", :keys))
      nack = put!(subject, network.id, message("alice", :nack))
      Enum.each([keys, nack], &age!(&1, 120))

      assert {:ok, []} = E2eInbox.expire(subject, network.id, DateTime.utc_now())
      assert E2eInbox.list(subject, network.id, 0) == []
    end

    test "touches only the subject and network asked for", %{subject: subject, network: network} do
      other = user_fixture()
      theirs = put!({:user, other.id}, network.id, message("alice", :msg))
      age!(theirs, 120)

      assert {:ok, []} = E2eInbox.expire(subject, network.id, DateTime.utc_now())
      assert [%Entry{}] = E2eInbox.list({:user, other.id}, network.id, 0)
    end
  end
end
