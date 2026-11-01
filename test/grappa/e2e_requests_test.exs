defmodule Grappa.E2eRequestsTest do
  @moduledoc """
  issue 2486 — the consent to start an encrypted chat, kept server-side:
  one row per (subject, network, folded peer), driven by the verb of the
  line alone. Every transition is planned purely and carried out by
  `commit/4`; the tests drive both halves through the context, so what
  they assert is what the session sees.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.E2eRequests
  alias Grappa.E2eRequests.{Request, Wire}

  # The master-key hint the proposal puts in every consent payload.
  @payload ~s({"v":2,"master":"m4st3rK3yHintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})

  setup do
    {:ok, subject: {:user, user_fixture().id}, network: network_fixture(), now: DateTime.utc_now()}
  end

  # Plans and commits one inbound line from `peer`, as the session does.
  defp inbound!(ctx, peer, verb, now) do
    row = E2eRequests.for_peer(ctx.subject, ctx.network.id, peer)

    {:ok, outcome} =
      E2eRequests.commit(ctx.subject, ctx.network.id, E2eRequests.inbound(row, verb, peer, @payload, now), now)

    outcome
  end

  defp ask!(ctx, peer, now) do
    row = E2eRequests.for_peer(ctx.subject, ctx.network.id, peer)
    {verb, plan} = E2eRequests.ask(row, peer, now)
    {:ok, outcome} = E2eRequests.commit(ctx.subject, ctx.network.id, plan, now)
    {verb, outcome}
  end

  defp row(ctx, peer), do: E2eRequests.for_peer(ctx.subject, ctx.network.id, peer)

  defp later(now, seconds), do: DateTime.add(now, seconds, :second)

  # Just past a pending row's deadline.
  defp past_deadline(now), do: later(now, E2eRequests.ttl_seconds() + 1)

  describe "an inbound REQUEST" do
    test "with nothing held opens an incoming request, fresh: the user is told", ctx do
      assert {:put, %Request{state: :incoming, peer: "Alice", payload: @payload}, true} =
               inbound!(ctx, "Alice", :request, ctx.now)
    end

    test "again refreshes the incoming request without telling the user again, and restarts its clock", ctx do
      {:put, first, true} = inbound!(ctx, "alice", :request, ctx.now)
      then = later(ctx.now, 3_600)

      assert {:put, %Request{id: id, state: :incoming} = refreshed, false} = inbound!(ctx, "ALICE", :request, then)
      assert id == first.id
      assert DateTime.compare(E2eRequests.expires_at(refreshed), E2eRequests.expires_at(first)) == :gt
    end

    test "after the incoming request lapsed is fresh again", ctx do
      {:put, _, true} = inbound!(ctx, "alice", :request, ctx.now)
      assert {:put, %Request{state: :incoming}, true} = inbound!(ctx, "alice", :request, past_deadline(ctx.now))
    end

    test "meeting our live outgoing request accepts it: their request is their consent", ctx do
      {:request, _} = ask!(ctx, "alice", ctx.now)
      assert {:put, %Request{state: :accepted, payload: @payload}, false} = inbound!(ctx, "alice", :request, ctx.now)
    end

    test "meeting our expired outgoing request is a new incoming one", ctx do
      {:request, _} = ask!(ctx, "alice", ctx.now)
      assert {:put, %Request{state: :incoming}, true} = inbound!(ctx, "alice", :request, past_deadline(ctx.now))
    end

    test "after a refusal is a new incoming request; after an acceptance it is dropped", ctx do
      {:request, _} = ask!(ctx, "alice", ctx.now)
      {:put, %Request{state: :refused}, false} = inbound!(ctx, "alice", :refuse, ctx.now)
      assert {:put, %Request{state: :incoming}, true} = inbound!(ctx, "alice", :request, ctx.now)

      {:request, _} = ask!(ctx, "bob", ctx.now)
      {:put, %Request{state: :accepted}, false} = inbound!(ctx, "bob", :accept, ctx.now)
      assert {:drop, :already_accepted} = inbound!(ctx, "bob", :request, ctx.now)
      assert %Request{state: :accepted} = row(ctx, "bob")
    end
  end

  describe "an inbound ACCEPT, REFUSE or CANCEL" do
    test "ACCEPT and REFUSE resolve our live outgoing request, keeping the peer's payload", ctx do
      {:request, _} = ask!(ctx, "alice", ctx.now)
      {:request, _} = ask!(ctx, "bob", ctx.now)

      assert {:put, %Request{state: :accepted, payload: @payload}, false} = inbound!(ctx, "alice", :accept, ctx.now)
      assert {:put, %Request{state: :refused, payload: @payload}, false} = inbound!(ctx, "bob", :refuse, ctx.now)
    end

    test "nobody asked: with nothing held, an incoming request, an answer, or past our deadline, they are dropped",
         ctx do
      for verb <- [:accept, :refuse, :cancel],
          do: assert({:drop, :unsolicited} = inbound!(ctx, "stranger", verb, ctx.now))

      assert row(ctx, "stranger") == nil

      {:put, _, true} = inbound!(ctx, "alice", :request, ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "alice", :accept, ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "alice", :refuse, ctx.now)
      assert %Request{state: :incoming} = row(ctx, "alice")

      {:request, _} = ask!(ctx, "bob", ctx.now)
      {:put, %Request{state: :accepted}, false} = inbound!(ctx, "bob", :accept, ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "bob", :refuse, ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "bob", :cancel, ctx.now)

      # A late answer: nobody is asking any more.
      {:request, _} = ask!(ctx, "carol", ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "carol", :accept, past_deadline(ctx.now))
      assert %Request{state: :outgoing} = row(ctx, "carol")
    end

    test "CANCEL withdraws the peer's incoming request, lapsed or not, and nothing else", ctx do
      {:put, incoming, true} = inbound!(ctx, "alice", :request, ctx.now)
      assert {:delete, %Request{id: id}} = inbound!(ctx, "alice", :cancel, ctx.now)
      assert id == incoming.id
      assert row(ctx, "alice") == nil

      {:put, _, true} = inbound!(ctx, "bob", :request, ctx.now)
      assert {:delete, _} = inbound!(ctx, "bob", :cancel, past_deadline(ctx.now))

      {:request, _} = ask!(ctx, "carol", ctx.now)
      assert {:drop, :unsolicited} = inbound!(ctx, "carol", :cancel, ctx.now)
      assert %Request{state: :outgoing} = row(ctx, "carol")
    end
  end

  describe "the user asking" do
    test "sends a REQUEST and holds an outgoing request with a deadline 24 h out", ctx do
      assert {:request, {:put, %Request{state: :outgoing, payload: nil} = request, false}} = ask!(ctx, "Alice", ctx.now)
      assert DateTime.diff(E2eRequests.expires_at(request), request.updated_at) == E2eRequests.ttl_seconds()
    end

    test "a peer whose request is waiting is answered: ACCEPT goes and the row reads accepted", ctx do
      {:put, incoming, true} = inbound!(ctx, "alice", :request, ctx.now)

      assert {:accept, {:put, %Request{id: id, state: :accepted, payload: @payload}, false}} =
               ask!(ctx, "ALICE", ctx.now)

      assert id == incoming.id
    end

    test "again, after an expiry or after a refusal, is a new request with a fresh deadline", ctx do
      {:request, {:put, first, false}} = ask!(ctx, "alice", ctx.now)
      expired = past_deadline(ctx.now)
      assert E2eRequests.expired?(first, expired)

      # A re-ask changes no column but the clock, which must still move.
      assert {:request, {:put, %Request{id: id, state: :outgoing} = again, false}} = ask!(ctx, "alice", expired)
      assert id == first.id
      refute E2eRequests.expired?(again, expired)

      {:put, %Request{state: :refused}, false} = inbound!(ctx, "alice", :refuse, expired)
      assert {:request, {:put, %Request{state: :outgoing, payload: nil}, false}} = ask!(ctx, "alice", expired)
    end
  end

  describe "answer/2 and dismiss/2" do
    test "only a live incoming request is answered; a lapsed one is not found, another state conflicts", ctx do
      {:put, incoming, true} = inbound!(ctx, "alice", :request, ctx.now)
      assert {:ok, {:delete, ^incoming}} = E2eRequests.answer(incoming, ctx.now)
      assert {:error, :not_found} = E2eRequests.answer(incoming, past_deadline(ctx.now))

      {:request, {:put, outgoing, false}} = ask!(ctx, "bob", ctx.now)
      assert {:error, :conflict} = E2eRequests.answer(outgoing, ctx.now)
    end

    test "a live outgoing request is cancelled; an expired one, an answer or a lapsed incoming one just goes", ctx do
      {:request, {:put, outgoing, false}} = ask!(ctx, "alice", ctx.now)
      assert {:cancel, {:delete, ^outgoing}} = E2eRequests.dismiss(outgoing, ctx.now)
      assert {:none, {:delete, ^outgoing}} = E2eRequests.dismiss(outgoing, past_deadline(ctx.now))

      {:put, accepted, false} = inbound!(ctx, "alice", :accept, ctx.now)
      assert {:none, {:delete, ^accepted}} = E2eRequests.dismiss(accepted, ctx.now)

      {:put, incoming, true} = inbound!(ctx, "bob", :request, ctx.now)
      assert {:error, :conflict} = E2eRequests.dismiss(incoming, ctx.now)
      assert {:none, {:delete, ^incoming}} = E2eRequests.dismiss(incoming, past_deadline(ctx.now))
    end

    test "a committed delete removes the row", ctx do
      {:request, {:put, outgoing, false}} = ask!(ctx, "alice", ctx.now)
      {:cancel, plan} = E2eRequests.dismiss(outgoing, ctx.now)

      assert {:ok, {:delete, ^outgoing}} = E2eRequests.commit(ctx.subject, ctx.network.id, plan, ctx.now)
      assert E2eRequests.get(ctx.subject, ctx.network.id, outgoing.id) == nil
    end
  end

  describe "bounds" do
    test "a new nick's REQUEST past #{E2eRequests.max_rows()} incoming rows is refused; a refresh still lands",
         ctx do
      # A row on our side that a REQUEST would move to theirs takes a room there.
      {:request, _} = ask!(ctx, "turncoat", ctx.now)
      {:put, %Request{state: :refused}, false} = inbound!(ctx, "turncoat", :refuse, ctx.now)

      for i <- 1..E2eRequests.max_rows(), do: {:put, _, true} = inbound!(ctx, "asker#{i}", :request, ctx.now)

      turncoat = E2eRequests.inbound(row(ctx, "turncoat"), :request, "turncoat", @payload, ctx.now)
      assert {:error, :requests_full} = E2eRequests.commit(ctx.subject, ctx.network.id, turncoat, ctx.now)
      assert %Request{state: :refused} = row(ctx, "turncoat")

      plan = E2eRequests.inbound(nil, :request, "onemore", @payload, ctx.now)
      assert {:error, :requests_full} = E2eRequests.commit(ctx.subject, ctx.network.id, plan, ctx.now)
      assert row(ctx, "onemore") == nil

      assert {:put, %Request{state: :incoming}, false} = inbound!(ctx, "asker1", :request, ctx.now)

      # Our side has room of its own.
      assert {:request, {:put, %Request{state: :outgoing}, false}} = ask!(ctx, "someone", ctx.now)
    end

    test "past #{E2eRequests.max_rows()} rows we started, a new ask is refused; asking again is not", ctx do
      for i <- 1..(E2eRequests.max_rows() - 1), do: {:request, _} = ask!(ctx, "peer#{i}", ctx.now)
      # An answer still counts as ours until it is shown.
      {:request, _} = ask!(ctx, "answered", ctx.now)
      {:put, %Request{state: :refused}, false} = inbound!(ctx, "answered", :refuse, ctx.now)

      {:request, plan} = E2eRequests.ask(nil, "onemore", ctx.now)
      assert {:error, :requests_full} = E2eRequests.commit(ctx.subject, ctx.network.id, plan, ctx.now)

      assert {:request, {:put, %Request{state: :outgoing}, false}} = ask!(ctx, "peer1", ctx.now)

      # Theirs has room of its own.
      assert {:put, %Request{state: :incoming}, true} = inbound!(ctx, "asker", :request, ctx.now)
    end

    test "payload?/1 takes compact JSON text up to 1 KiB and nothing else" do
      assert E2eRequests.payload?(@payload)
      assert E2eRequests.payload?(String.duplicate("a", Request.max_payload_bytes()))
      refute E2eRequests.payload?(String.duplicate("a", Request.max_payload_bytes() + 1))
      refute E2eRequests.payload?("")
      refute E2eRequests.payload?(~s({"v": 2}))
      refute E2eRequests.payload?(nil)
    end
  end

  describe "the fold, the partition and the sweep" do
    test "a peer is one row however it is cased, and `[ ] \\ ~` stay distinct", ctx do
      {:put, first, true} = inbound!(ctx, "Alice[1]", :request, ctx.now)
      assert %Request{id: id} = row(ctx, "ALICE[1]")
      assert id == first.id
      assert row(ctx, "alice{1}") == nil
    end

    test "another subject's or another network's requests are out of reach; a visitor has its own", ctx do
      {:put, mine, true} = inbound!(ctx, "alice", :request, ctx.now)

      other = %{ctx | subject: {:user, user_fixture().id}}
      assert E2eRequests.get(other.subject, ctx.network.id, mine.id) == nil
      assert E2eRequests.list(other.subject, ctx.network.id, ctx.now) == []
      assert E2eRequests.list(ctx.subject, network_fixture().id, ctx.now) == []

      visitor = %{ctx | subject: {:visitor, visitor_fixture().id}}
      assert {:put, %Request{visitor_id: vid}, true} = inbound!(visitor, "alice", :request, ctx.now)
      assert {:visitor, vid} == visitor.subject
      assert [%Request{id: id}] = E2eRequests.list(ctx.subject, ctx.network.id, ctx.now)
      assert id == mine.id
    end

    test "list/3 drops a lapsed incoming request and keeps an expired outgoing one, oldest first", ctx do
      {:request, {:put, outgoing, false}} = ask!(ctx, "alice", ctx.now)
      {:put, _, true} = inbound!(ctx, "bob", :request, ctx.now)

      assert [%Request{id: id}] = E2eRequests.list(ctx.subject, ctx.network.id, past_deadline(ctx.now))
      assert id == outgoing.id
      assert length(E2eRequests.list(ctx.subject, ctx.network.id, ctx.now)) == 2
    end

    test "expire/3 deletes and returns the lapsed incoming requests, nothing else", ctx do
      {:request, {:put, outgoing, false}} = ask!(ctx, "alice", ctx.now)
      {:put, incoming, true} = inbound!(ctx, "bob", :request, ctx.now)
      {:put, fresh, true} = inbound!(ctx, "carol", :request, later(ctx.now, 3_600))

      assert {:ok, []} = E2eRequests.expire(ctx.subject, ctx.network.id, ctx.now)
      assert {:ok, [%Request{id: id}]} = E2eRequests.expire(ctx.subject, ctx.network.id, past_deadline(ctx.now))
      assert id == incoming.id

      assert ctx.subject |> E2eRequests.list(ctx.network.id, ctx.now) |> Enum.map(& &1.id) == [outgoing.id, fresh.id]
    end
  end

  describe "Wire" do
    test "an outgoing request past its deadline reads expired, with its deadline; an answer has none", ctx do
      {:request, {:put, outgoing, false}} = ask!(ctx, "alice", ctx.now)

      assert %{state: :outgoing, expires_at: deadline, at: at, peer: "alice", payload: nil} =
               Wire.request(outgoing, ctx.now)

      assert deadline == DateTime.to_iso8601(E2eRequests.expires_at(outgoing))
      assert at == DateTime.to_iso8601(outgoing.updated_at)
      assert %{state: :expired, expires_at: ^deadline} = Wire.request(outgoing, past_deadline(ctx.now))

      {:put, accepted, false} = inbound!(ctx, "alice", :accept, ctx.now)
      assert %{state: :accepted, expires_at: nil, payload: @payload} = Wire.request(accepted, ctx.now)
    end

    test "the two events name the network, and the gone one only the id", ctx do
      {:put, incoming, true} = inbound!(ctx, "alice", :request, ctx.now)

      assert %{kind: :e2e_request, network: "azzurra", request: %{id: id, state: :incoming}} =
               Wire.request_payload("azzurra", incoming, ctx.now)

      assert id == incoming.id
      assert Wire.gone_payload("azzurra", incoming) == %{kind: :e2e_request_gone, network: "azzurra", id: incoming.id}
    end
  end
end
