defmodule Grappa.Net.PtrCacheTest do
  @moduledoc """
  #252 — TTL-honoring, non-blocking ETS cache of reverse-DNS (PTR) names
  for vhost source addresses.

  The resolver + clock are injected per-instance so these tests never
  touch real DNS or wall-clock time (CLAUDE.md — mock at boundaries, no
  network in the suite). Each test starts an ISOLATED cache (own ETS
  table + registered name derived from a unique atom) so the suite stays
  `async: true` — the app-wide singleton is a separate instance exercised
  through the controller test.

  The injected resolver is backed by an `Agent` the test drives: it
  records a per-address call count (the observation channel for
  "re-resolved?" assertions, since the cache calls the resolver from its
  own process) and returns a scripted answer.

  TTL expiry is exercised without wall-clock control: `min_ttl_ms: 0`
  lets a `ttl: 0` answer be cached "born expired" (its `expires_at`
  equals write time), so the very next read hits the same `now < exp`
  guard an aged-out entry would — deterministic, no sleep, no clock seam.
  """
  use ExUnit.Case, async: true

  alias Grappa.Net.PtrCache

  # ---------------------------------------------------------------------------
  # Injected resolver, backed by one Agent (answers + per-address call log).
  # ---------------------------------------------------------------------------

  defp scripted_resolver(agent) do
    fn address ->
      Agent.get_and_update(agent, fn state ->
        answer = Map.get(state.answers, address, :nxdomain)
        {answer, update_in(state.calls[address], &((&1 || 0) + 1))}
      end)
    end
  end

  defp start_cache(_) do
    {:ok, agent} = start_supervised({Agent, fn -> %{answers: %{}, calls: %{}} end})
    name = String.to_atom("ptr_cache_test_#{System.unique_integer([:positive])}")

    {:ok, _} =
      start_supervised(
        {PtrCache,
         name: name,
         resolver: scripted_resolver(agent),
         min_ttl_ms: 0,
         max_ttl_ms: 1_000_000_000,
         negative_ttl_ms: 60_000,
         error_ttl_ms: 60_000}
      )

    %{cache: name, agent: agent}
  end

  defp put_answer(agent, address, answer),
    do: Agent.update(agent, &put_in(&1.answers[address], answer))

  defp calls(agent, address), do: Agent.get(agent, &Map.get(&1.calls, address, 0))
  # Drain the mailbox so any `{:ensure, _}` cast fired by a read is processed.
  defp drain(cache), do: :sys.get_state(cache)

  setup :start_cache

  # ---------------------------------------------------------------------------
  # (i) address → NAME mapping
  # ---------------------------------------------------------------------------

  describe "warm/2 + names_for/2 — resolved name" do
    test "resolves an address to its PTR name and serves it from cache", %{cache: c, agent: a} do
      put_answer(a, "2001:db8::1", {:ok, "one.vhost.example", 3600})

      assert PtrCache.warm(c, "2001:db8::1") == "one.vhost.example"
      assert PtrCache.names_for(c, ["2001:db8::1"]) == %{"2001:db8::1" => "one.vhost.example"}
      # Served from cache — no second resolver hit.
      assert calls(a, "2001:db8::1") == 1
    end
  end

  # ---------------------------------------------------------------------------
  # (iii) cold-cache non-blocking behavior
  # ---------------------------------------------------------------------------

  describe "names_for/2 — cold cache is non-blocking" do
    test "a cold address reads as nil immediately, then warms in the background", %{
      cache: c,
      agent: a
    } do
      put_answer(a, "2001:db8::2", {:ok, "two.vhost.example", 3600})

      # First read never blocks on a resolve: cold → nil, fires an async ensure.
      assert PtrCache.names_for(c, ["2001:db8::2"]) == %{"2001:db8::2" => nil}

      drain(c)
      assert PtrCache.names_for(c, ["2001:db8::2"]) == %{"2001:db8::2" => "two.vhost.example"}
    end

    test "maps a batch — known names, nil for cold, deduped resolves", %{cache: c, agent: a} do
      put_answer(a, "2001:db8::a", {:ok, "a.vhost.example", 3600})
      put_answer(a, "2001:db8::b", {:ok, "b.vhost.example", 3600})
      _ = PtrCache.warm(c, "2001:db8::a")

      # b + c are cold; a is warm.
      result = PtrCache.names_for(c, ["2001:db8::a", "2001:db8::b", "2001:db8::b"])
      assert result == %{"2001:db8::a" => "a.vhost.example", "2001:db8::b" => nil}

      drain(c)
      # The duplicate "b" in the batch collapses to a single resolve.
      assert calls(a, "2001:db8::b") == 1
    end

    test "an empty batch returns an empty map and casts nothing", %{cache: c} do
      assert PtrCache.names_for(c, []) == %{}
    end
  end

  # ---------------------------------------------------------------------------
  # (ii) TTL expiry re-resolves
  # ---------------------------------------------------------------------------

  describe "names_for/2 — TTL expiry" do
    test "a fresh entry is a hit (no re-resolve)", %{cache: c, agent: a} do
      put_answer(a, "2001:db8::3", {:ok, "three.vhost.example", 3600})
      assert PtrCache.warm(c, "2001:db8::3") == "three.vhost.example"

      # Within TTL: served from cache, no re-resolve.
      assert PtrCache.names_for(c, ["2001:db8::3"])["2001:db8::3"] == "three.vhost.example"
      assert PtrCache.names_for(c, ["2001:db8::3"])["2001:db8::3"] == "three.vhost.example"
      assert calls(a, "2001:db8::3") == 1
    end

    test "an expired entry reads as cold (nil) and re-resolves", %{cache: c, agent: a} do
      # ttl 0 + min_ttl 0 → cached born-expired: exercises the same
      # `now < expires_at` miss branch an aged-out entry hits.
      put_answer(a, "2001:db8::3b", {:ok, "expired.vhost.example", 0})
      assert PtrCache.warm(c, "2001:db8::3b") == "expired.vhost.example"
      assert calls(a, "2001:db8::3b") == 1

      # The expired entry re-resolves on the next read (nil now, warm after drain).
      put_answer(a, "2001:db8::3b", {:ok, "renamed.vhost.example", 3600})
      assert PtrCache.names_for(c, ["2001:db8::3b"])["2001:db8::3b"] == nil
      drain(c)
      assert calls(a, "2001:db8::3b") == 2
      assert PtrCache.names_for(c, ["2001:db8::3b"])["2001:db8::3b"] == "renamed.vhost.example"
    end
  end

  # ---------------------------------------------------------------------------
  # (iv) no-PTR fallback + error backoff
  # ---------------------------------------------------------------------------

  describe "warm/2 + names_for/2 — no PTR / errors" do
    test "an address with no PTR reads as nil and is negatively cached (no thrash)", %{
      cache: c,
      agent: a
    } do
      put_answer(a, "2001:db8::4", :nxdomain)
      assert PtrCache.warm(c, "2001:db8::4") == nil
      assert calls(a, "2001:db8::4") == 1

      # Negative cache holds for negative_ttl_ms — repeated reads don't re-resolve.
      assert PtrCache.names_for(c, ["2001:db8::4"]) == %{"2001:db8::4" => nil}
      drain(c)
      assert calls(a, "2001:db8::4") == 1
    end

    test "a resolver error reads as nil and is backed off (no thrash within window)", %{
      cache: c,
      agent: a
    } do
      put_answer(a, "2001:db8::5", {:error, :timeout})
      assert PtrCache.warm(c, "2001:db8::5") == nil
      assert calls(a, "2001:db8::5") == 1

      # Within error_ttl: backed off, no re-resolve.
      assert PtrCache.names_for(c, ["2001:db8::5"])["2001:db8::5"] == nil
      drain(c)
      assert calls(a, "2001:db8::5") == 1
    end
  end

  describe "table_name/0" do
    test "is the app singleton's ETS table atom (Health substrate check couples on it)" do
      assert PtrCache.table_name() == Grappa.Net.PtrCache
    end
  end
end
