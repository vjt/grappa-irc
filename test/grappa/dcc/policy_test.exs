defmodule Grappa.Dcc.PolicyTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [network_fixture: 0, user_fixture: 0]

  alias Grappa.Dcc
  alias Grappa.Dcc.Policy
  alias Grappa.IRC.DCC.Offer

  defp offer(over \\ []) do
    defaults = [filename: "holiday.tar.gz", ip: {203, 0, 113, 7}, port: 5000, size: 4096]
    struct!(Offer, Keyword.merge(defaults, over))
  end

  describe "admit_offer/1 — what is knowable before the operator is even asked" do
    test "a routable public address with a sane claim is admitted" do
      assert :ok = Policy.admit_offer(offer())
    end

    test "loopback is refused — this gate is why Transfer has none" do
      # `Transfer`'s own tests dial real loopback sockets, which is only
      # honest because the SSRF gate lives HERE and not there.
      assert {:error, :ssrf_blocked} = Policy.admit_offer(offer(ip: {127, 0, 0, 1}))
    end

    test "every private and link-local class a peer might reach for is refused" do
      for ip <- [
            {10, 0, 0, 5},
            {172, 16, 0, 5},
            {192, 168, 1, 5},
            {169, 254, 169, 254},
            {0, 0, 0, 0},
            {0, 0, 0, 0, 0, 0, 0, 1}
          ] do
        assert {:error, :ssrf_blocked} = Policy.admit_offer(offer(ip: ip)),
               "#{inspect(ip)} was admitted"
      end
    end

    test "a v4-mapped loopback cannot smuggle past the v6 arm" do
      # `::ffff:127.0.0.1`. The parser decodes an IPv6 literal into a
      # tuple, so this shape really can arrive.
      assert {:error, :ssrf_blocked} =
               Policy.admit_offer(offer(ip: {0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 1}))
    end

    test "a claim over the per-transfer ceiling is refused before any socket exists" do
      over = Dcc.max_transfer_bytes() + 1
      assert {:error, :too_large} = Policy.admit_offer(offer(size: over))
    end

    test "a claim exactly AT the ceiling is admitted — the bound is inclusive" do
      assert :ok = Policy.admit_offer(offer(size: Dcc.max_transfer_bytes()))
    end

    test "a zero-byte claim is admitted — an empty file is a legal offer" do
      assert :ok = Policy.admit_offer(offer(size: 0))
    end

    test "the address is judged BEFORE the size — the worse answer wins" do
      # Both wrong: the reported reason must be the one that says "stop
      # talking to this peer", not the one that says "ask for a smaller
      # file".
      bad = offer(ip: {127, 0, 0, 1}, size: Dcc.max_transfer_bytes() + 1)
      assert {:error, :ssrf_blocked} = Policy.admit_offer(bad)
    end

    test "it says nothing about quota or disk — those belong to the accept" do
      # Offers arrive unprompted; spending a subject's daily allowance on
      # traffic they never answered would let any stranger exhaust it.
      for _ <- 1..(Policy.daily_accepts() * 2), do: assert(:ok = Policy.admit_offer(offer()))
    end
  end

  describe "admit_accept/1 — the questions whose answers depend on us" do
    setup do
      {:ok, subject: {:user, user_fixture().id}, network_id: network_fixture().id}
    end

    test "a first accept is admitted", ctx do
      assert :ok = Policy.admit_accept(ctx.subject)
    end

    test "the daily allowance is spent per accept and then refuses", ctx do
      for _ <- 1..Policy.daily_accepts(), do: assert(:ok = Policy.admit_accept(ctx.subject))

      assert {:error, :rate_limited} = Policy.admit_accept(ctx.subject)
    end

    test "the allowance is PER SUBJECT, not global", ctx do
      for _ <- 1..Policy.daily_accepts(), do: Policy.admit_accept(ctx.subject)

      assert :ok = Policy.admit_accept({:user, user_fixture().id})
    end

    test "a full spool refuses with its own reason, not the quota's", ctx do
      # The two axes stay distinguishable: an operator told "no room left"
      # knows it is not about them.
      headroom = Dcc.global_cap_bytes() - Dcc.max_transfer_bytes() + 1

      {:ok, _} =
        Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), %{
          peer_nick: "vjt",
          filename: "big.bin",
          bytes: headroom,
          retention_seconds: Dcc.max_retention_seconds()
        })

      assert {:error, :insufficient_storage} = Policy.admit_accept(ctx.subject)
    end
  end
end
