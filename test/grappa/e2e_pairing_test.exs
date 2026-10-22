defmodule Grappa.E2ePairingTest do
  @moduledoc """
  `Grappa.E2ePairing`, the blind relay two devices of one account pair
  through (grappa-irc#2430, X1). Each side is the auth session of a
  device: the creator's at open, the joiner's at join.

  `async: false`: the relay is one application-wide process, and the
  expiry tests sweep it with a clock past every rendezvous in it.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.E2ePairing
  alias Grappa.E2ePairing.{Message, Rendezvous}
  alias Grappa.PubSub.Topic

  @ttl_ms E2ePairing.ttl_ms()

  # A device of `user`: its auth session id, the side of a rendezvous.
  defp device(user), do: session_fixture(user).id

  defp subject(user), do: {:user, user.id}

  setup do
    user = user_fixture()
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
    %{user: user, a: device(user), b: device(user)}
  end

  defp open!(user, session) do
    {:ok, r} = E2ePairing.open(subject(user), user.name, session)
    r
  end

  defp joined!(user, a, b) do
    r = open!(user, a)
    {:ok, _} = E2ePairing.join(subject(user), b, r.id)
    r
  end

  describe "open/3" do
    test "opens a rendezvous whose creator is the opening device", %{user: user, a: a} do
      r = open!(user, a)
      assert byte_size(r.id) == 22
      assert r.id =~ ~r/\A[A-Za-z0-9_-]{22}\z/
      assert Rendezvous.role(r, a) == :creator
      assert DateTime.diff(r.expires_at, DateTime.utc_now(), :millisecond) in (@ttl_ms - 5_000)..@ttl_ms
    end

    test "two opens give two ids", %{user: user, a: a} do
      refute open!(user, a).id == open!(user, a).id
    end

    test "a second open replaces the subject's live rendezvous", %{user: user, a: a, b: b} do
      first = open!(user, a)
      _ = open!(user, b)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: :replaced}
      }

      assert id == first.id
      assert E2ePairing.join(subject(user), b, first.id) == {:error, :not_found}
    end

    test "another subject's open replaces nothing", %{user: user, a: a, b: b} do
      r = open!(user, a)
      other = user_fixture()
      _ = open!(other, device(other))
      assert {:ok, _} = E2ePairing.join(subject(user), b, r.id)
    end

    test "opens are rate limited per subject", %{user: user, a: a} do
      results = for _ <- 1..(E2ePairing.open_burst() + 1), do: E2ePairing.open(subject(user), user.name, a)
      assert List.last(results) == {:error, :rate_limited}
      assert Enum.count(results, &match?({:ok, _}, &1)) == E2ePairing.open_burst()
      other = user_fixture()
      assert {:ok, _} = E2ePairing.open(subject(other), other.name, device(other))
    end
  end

  describe "join/3" do
    test "the joiner is the joining device", %{user: user, a: a, b: b} do
      r = open!(user, a)
      assert {:ok, joined} = E2ePairing.join(subject(user), b, r.id)
      assert joined.id == r.id
      assert Rendezvous.role(joined, b) == :joiner
      assert Rendezvous.role(joined, a) == :creator
    end

    test "a second joiner is told the rendezvous is used", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      assert E2ePairing.join(subject(user), device(user), r.id) == {:error, :pairing_already_joined}
      assert E2ePairing.join(subject(user), b, r.id) == {:error, :pairing_already_joined}
    end

    test "the creating device cannot join its own rendezvous", %{user: user, a: a} do
      r = open!(user, a)
      assert E2ePairing.join(subject(user), a, r.id) == {:error, :pairing_own_rendezvous}
    end

    test "another subject cannot find it", %{user: user, a: a} do
      r = open!(user, a)
      other = user_fixture()
      assert E2ePairing.join(subject(other), device(other), r.id) == {:error, :not_found}
    end

    test "a visitor cannot find a user's rendezvous", %{user: user, a: a} do
      r = open!(user, a)
      {visitor, session} = visitor_and_session()
      assert E2ePairing.join({:visitor, visitor.id}, session.id, r.id) == {:error, :not_found}
    end

    test "an unknown id is not found", %{user: user, b: b} do
      assert E2ePairing.join(subject(user), b, "AAAAAAAAAAAAAAAAAAAAAA") == {:error, :not_found}
    end
  end

  describe "post/4 and messages/4" do
    test "the joiner speaks first, then the sides alternate freely", %{user: user, a: a, b: b} do
      r = open!(user, a)
      assert E2ePairing.post(subject(user), a, r.id, "aGVsbG8") == {:error, :pairing_not_joined}
      {:ok, _} = E2ePairing.join(subject(user), b, r.id)

      assert {:ok, %Message{seq: 1, from: :joiner, payload: "aGVsbG8"}} =
               E2ePairing.post(subject(user), b, r.id, "aGVsbG8")

      assert {:ok, %Message{seq: 2, from: :creator}} = E2ePairing.post(subject(user), a, r.id, "d29ybGQ")
      assert {:ok, %Message{seq: 3, from: :creator}} = E2ePairing.post(subject(user), a, r.id, "YWdhaW4")
    end

    test "every message rings the user topic, without its payload", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      {:ok, _} = E2ePairing.post(subject(user), b, r.id, "aGVsbG8=")
      assert_receive %Phoenix.Socket.Broadcast{event: "event", payload: payload}
      # Every device of the account hears the push; only the two sides may
      # fetch what was said.
      assert payload == %{kind: :e2e_pairing_message, rendezvous_id: r.id, seq: 1, from: :joiner}
    end

    test "messages/4 gives each side what the other one sent, after a seq", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      {:ok, _} = E2ePairing.post(subject(user), b, r.id, "b25l")
      {:ok, _} = E2ePairing.post(subject(user), a, r.id, "dHdv")
      {:ok, _} = E2ePairing.post(subject(user), b, r.id, "dGhyZWU")
      assert {:ok, [%Message{seq: 1}, %Message{seq: 3}]} = E2ePairing.messages(subject(user), a, r.id, 0)
      assert {:ok, [%Message{seq: 3}]} = E2ePairing.messages(subject(user), a, r.id, 1)
      assert {:ok, [%Message{seq: 2, payload: "dHdv"}]} = E2ePairing.messages(subject(user), b, r.id, 0)
      assert {:ok, []} = E2ePairing.messages(subject(user), b, r.id, 2)
    end

    test "a third device of the subject is not a party", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      c = device(user)
      assert E2ePairing.post(subject(user), c, r.id, "eA") == {:error, :pairing_not_a_party}
      assert E2ePairing.messages(subject(user), c, r.id, 0) == {:error, :pairing_not_a_party}
      assert E2ePairing.close(subject(user), c, r.id) == {:error, :pairing_not_a_party}
    end

    test "another subject cannot post, read or close", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      other = user_fixture()
      o = device(other)
      assert E2ePairing.post(subject(other), o, r.id, "eA") == {:error, :not_found}
      assert E2ePairing.messages(subject(other), o, r.id, 0) == {:error, :not_found}
      assert E2ePairing.close(subject(other), o, r.id) == {:error, :not_found}
    end

    test "a payload is base64 text of at most 16 KiB", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      max = E2ePairing.max_message_bytes()
      assert max == 16_384
      assert {:ok, _} = E2ePairing.post(subject(user), b, r.id, String.duplicate("A", max))

      for bad <- [String.duplicate("A", max + 1), "", "not base64!", "é", nil, 42, ["A"]] do
        assert {:error, %Ecto.Changeset{}} = E2ePairing.post(subject(user), b, r.id, bad)
      end

      for ok <- ["AZaz09+/", "AZaz09-_", "QQ==", "QQ"] do
        assert {:ok, _} = E2ePairing.post(subject(user), a, r.id, ok)
      end
    end

    test "a rendezvous holds 64 KiB in all", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      chunk = String.duplicate("A", E2ePairing.max_message_bytes())
      total = E2ePairing.max_total_bytes()
      assert total == 65_536
      for _ <- 1..div(total, byte_size(chunk)), do: {:ok, _} = E2ePairing.post(subject(user), b, r.id, chunk)
      assert E2ePairing.post(subject(user), a, r.id, "QQ") == {:error, :pairing_full}
    end

    test "a rendezvous holds a bounded number of messages", %{user: user, a: a, b: b} do
      r = joined!(user, a, b)
      for _ <- 1..E2ePairing.max_messages(), do: {:ok, _} = E2ePairing.post(subject(user), b, r.id, "QQ")
      assert E2ePairing.post(subject(user), b, r.id, "QQ") == {:error, :pairing_full}
    end
  end

  describe "close/3" do
    test "either side closes it, for both, with a broadcast", %{user: user, a: a, b: b} do
      for closer <- [:creator, :joiner] do
        r = joined!(user, a, b)
        session = if closer == :creator, do: a, else: b
        assert E2ePairing.close(subject(user), session, r.id) == :ok

        assert_receive %Phoenix.Socket.Broadcast{
          payload: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: :closed}
        }

        assert id == r.id
        assert E2ePairing.post(subject(user), a, r.id, "QQ") == {:error, :not_found}
        assert E2ePairing.messages(subject(user), b, r.id, 0) == {:error, :not_found}
        assert E2ePairing.join(subject(user), device(user), r.id) == {:error, :not_found}
      end
    end

    test "a closed id is never usable again", %{user: user, a: a} do
      r = open!(user, a)
      :ok = E2ePairing.close(subject(user), a, r.id)
      assert E2ePairing.close(subject(user), a, r.id) == {:error, :not_found}
    end
  end

  describe "expiry" do
    test "the sweep closes what expired and keeps the rest", %{user: user, a: a, b: b} do
      assert @ttl_ms == 300_000
      r = joined!(user, a, b)
      now = System.monotonic_time(:millisecond)
      :ok = E2ePairing.sweep(now + @ttl_ms - 1_000)
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_pairing_closed}}
      assert {:ok, _} = E2ePairing.post(subject(user), b, r.id, "QQ")
      :ok = E2ePairing.sweep(now + @ttl_ms + 1_000)

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: :expired}
      }

      assert id == r.id
      assert E2ePairing.post(subject(user), b, r.id, "QQ") == {:error, :not_found}
      assert E2ePairing.join(subject(user), device(user), r.id) == {:error, :not_found}
    end

    # The production path: each rendezvous's timer lands here, which reads
    # the clock itself instead of taking one from the caller as the sweep
    # seam does. Driven directly, on a state of its own.
    test "a timer's expire closes the rendezvous whose ttl ended, not a live one",
         %{user: user, a: a, b: b} do
      dead = Rendezvous.new(subject(user), user.name, a, -1)
      live = Rendezvous.new(subject(user), user.name, b, @ttl_ms)
      state = %{dead.id => dead, live.id => live}

      assert {:noreply, left} = E2ePairing.handle_info({:expire, dead.id}, state)
      assert left == %{live.id => live}

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: :expired}
      }

      assert id == dead.id
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :e2e_pairing_closed}}
    end
  end
end
