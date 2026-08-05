defmodule Grappa.PresenceFilter.ResolverTest do
  @moduledoc """
  #505 — the I/O half of the presence decision: read the server-owned
  tri-state pref (#449) and the LIVE member count, then apply
  `Grappa.PresenceFilter.hidden?/2` (the pure rule, #458).

  `PresenceFilter` itself stays dep-free and is unit-tested in
  `presence_filter_test.exs`; this file covers only what the resolver adds
  — the pref key derivation, the "count only when unset" call gate, and the
  bulk `%{slug => MapSet}` fan-out the `/me` cold-load needs.

  `async: false`: the live-count branches need a real `Session.Server`, and
  Session uses singleton supervisors + Registry (same rationale as
  `Grappa.Session.ServerTest`).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, PresenceFilter, UserSettings}
  alias Grappa.PresenceFilter.Resolver

  defp welcome_handler do
    fn state, line ->
      if String.starts_with?(line, "USER ") do
        {:reply, ":irc 001 grappa-test :Welcome\r\n", state}
      else
        {:reply, nil, state}
      end
    end
  end

  defp start_server do
    {:ok, server} = IRCServer.start_link(welcome_handler())
    {server, IRCServer.port(server)}
  end

  # A live session joined to `channel` with exactly `n` members seeded via a
  # 353/366 NAMES burst. Returns `{network, pid, server}`.
  defp session_with_members(user, channel, n) do
    {server, port} = start_server()
    slug = "az-#{System.unique_integer([:positive])}"
    {network, _} = network_with_server(port: port, slug: slug)

    _ =
      credential_fixture(user, network, %{nick: "grappa-test", autojoin_channels: [channel]})

    pid = start_session_for(user, network)

    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    IRCServer.feed(server, ":grappa-test!u@h JOIN :#{channel}\r\n")

    # The self-JOIN already seeds `grappa-test`, so the burst supplies the
    # remaining n-1 nicks and the count lands exactly on `n`.
    nicks = Enum.map_join(1..(n - 1), " ", &"peer#{&1}")
    IRCServer.feed(server, ":irc 353 grappa-test = #{channel} :grappa-test #{nicks}\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #{channel} :End\r\n")
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)

    {network, pid}
  end

  defp pin(subject, key, value) do
    prefs = UserSettings.get_display_prefs(subject)

    {:ok, _} =
      UserSettings.put_display_prefs(
        subject,
        %{prefs | presence_filter: Map.put(prefs.presence_filter, key, value)}
      )

    :ok
  end

  # The composite pref key, pinned LITERALLY here on purpose. It is a
  # cross-stack contract with cic's `channelKey(slug, name)`
  # (`cicchetto/src/lib/channelKey.ts`: `${slug} ${canonicalChannel(name)}`),
  # so deriving it from the production helper would make this test agree with
  # whatever the server does — including a drift that silently orphans every
  # pin an operator has already saved.
  defp key(slug, channel), do: "#{slug} #{channel}"

  describe "hidden?/4 — single window" do
    test ~s(an explicit "hide" pin hides, with no session and no member count) do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      {network, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")

      :ok = pin(subject, key(network.slug, "#chan"), "hide")

      assert Resolver.hidden?(subject, network.slug, network.id, "#chan")
    end

    test "an unset channel with no live session SHOWS (decision D, #458)" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      {network, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")

      refute Resolver.hidden?(subject, network.slug, network.id, "#chan")
    end

    test "the pin is looked up under the FOLDED channel, whatever casing is asked" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      {network, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")

      :ok = pin(subject, key(network.slug, "#chan"), "hide")

      assert Resolver.hidden?(subject, network.slug, network.id, "#CHAN")
    end

    test "a pin on ANOTHER network's same-named channel does not apply" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      {net_a, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")
      {net_b, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")

      :ok = pin(subject, key(net_a.slug, "#chan"), "hide")

      assert Resolver.hidden?(subject, net_a.slug, net_a.id, "#chan")
      refute Resolver.hidden?(subject, net_b.slug, net_b.id, "#chan")
    end

    test "an unset channel at or above the threshold hides by the size default" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      big = PresenceFilter.large_channel_threshold()
      {network, pid} = session_with_members(user, "#big", big)

      assert Resolver.hidden?(subject, network.slug, network.id, "#big")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "an unset channel below the threshold shows" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      small = PresenceFilter.large_channel_threshold() - 1
      {network, pid} = session_with_members(user, "#small", small)

      refute Resolver.hidden?(subject, network.slug, network.id, "#small")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # The whole point of the tri-state: an explicit choice beats the size
    # default in BOTH directions. Without a live oversized channel this
    # assertion is vacuous, which is why it needs the session.
    test ~s(an explicit "show" pin beats the size default on an oversized channel) do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      big = PresenceFilter.large_channel_threshold()
      {network, pid} = session_with_members(user, "#big", big)

      :ok = pin(subject, key(network.slug, "#big"), "show")

      refute Resolver.hidden?(subject, network.slug, network.id, "#big")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "hidden_channels/2 — the /me cold-load fan-out" do
    test "is the union of explicit hides and oversized unset channels, by slug" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      big = PresenceFilter.large_channel_threshold()
      {network, pid} = session_with_members(user, "#big", big)

      # A small channel on the same live session: joined, seeded, under the
      # threshold — must stay OUT of the set.
      :ok = pin(subject, key(network.slug, "#pinned"), "hide")

      hidden = Resolver.hidden_channels(subject, %{network.slug => {network.id, "grappa-test"}})

      assert MapSet.member?(hidden[network.slug], "#big")
      assert MapSet.member?(hidden[network.slug], "#pinned")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test ~s(an explicit "show" on an oversized channel is EXCLUDED from the set) do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      big = PresenceFilter.large_channel_threshold()
      {network, pid} = session_with_members(user, "#big", big)

      :ok = pin(subject, key(network.slug, "#big"), "show")

      hidden = Resolver.hidden_channels(subject, %{network.slug => {network.id, "grappa-test"}})

      refute MapSet.member?(Map.get(hidden, network.slug, MapSet.new()), "#big")

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "with no live session, only the explicit hides survive" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}
      {network, _} = network_with_server(port: 6667, slug: "az-#{System.unique_integer([:positive])}")

      :ok = pin(subject, key(network.slug, "#pinned"), "hide")
      :ok = pin(subject, key(network.slug, "#shown"), "show")

      # `own_nicks` carries only LIVE networks (`BadgeCount.live_nick_windows/1`),
      # so this network is absent from it — the pin must still be honoured,
      # because a pref outlives the session that motivated it.
      hidden = Resolver.hidden_channels(subject, %{})

      assert MapSet.member?(hidden[network.slug], "#pinned")
      refute MapSet.member?(hidden[network.slug], "#shown")
    end

    test "a subject with no pins and no sessions yields an empty map" do
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

      assert Resolver.hidden_channels({:user, user.id}, %{}) == %{}
    end
  end
end
