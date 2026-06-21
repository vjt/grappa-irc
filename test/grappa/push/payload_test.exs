defmodule Grappa.Push.PayloadTest do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — payload shape.

  Pure function under test — no DB, `async: true` safe.
  """
  use ExUnit.Case, async: true

  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  defp msg(opts) do
    %Message{
      id: opts[:id] || 1,
      channel: opts[:channel],
      sender: opts[:sender] || "alice",
      body: Keyword.get(opts, :body, "hello"),
      kind: opts[:kind] || :privmsg,
      server_time: 1_700_000_000_000,
      dm_with: opts[:dm_with]
    }
  end

  describe "build/3 — channel message" do
    test "title is '<sender> in <channel>'" do
      payload = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera", "vjt")
      assert payload.title == "alice in #sniffo"
      assert payload.body == "hi"
    end

    test "tag = '<network_slug>:<channel>' for OS dedup" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert payload.tag == "libera:#sniffo"
    end

    test "url percent-encodes channel #" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%23sniffo"
    end

    test "url percent-encodes UTF-8 channel names" do
      payload = Payload.build(msg(channel: "#café"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%23caf%C3%A9"
    end

    test "url percent-encodes ampersand-prefixed channel" do
      payload = Payload.build(msg(channel: "&local"), "libera", "vjt")
      assert payload.url == "/?network=libera&channel=%26local"
    end
  end

  describe "build/3 — DM (channel == own_nick)" do
    test "title is just the sender nick" do
      payload =
        Payload.build(
          msg(channel: "vjt", sender: "alice", body: "ping", dm_with: "alice"),
          "libera",
          "vjt"
        )

      assert payload.title == "alice"
      assert payload.body == "ping"
    end

    test "tag = '<network_slug>:<sender>' (groups same-peer DMs)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera", "vjt")

      assert payload.tag == "libera:alice"
    end

    test "url deep-links to the peer nick (not own_nick)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera", "vjt")

      assert payload.url == "/?network=libera&channel=alice"
    end
  end

  describe "build/3 — degenerate inputs" do
    test "nil body becomes empty string (no crash)" do
      payload = Payload.build(msg(channel: "#sniffo", body: nil), "libera", "vjt")
      assert payload.body == ""
    end

    test "shape is always the four required atom keys" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  describe "put_badge/2 — door #1 icon-badge stamp" do
    test "adds the :badge key, preserving the base payload" do
      base = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera", "vjt")
      stamped = Payload.put_badge(base, 7)

      assert stamped.badge == 7
      # base fields untouched
      assert stamped.title == base.title
      assert stamped.body == base.body
      assert stamped.tag == base.tag
      assert stamped.url == base.url
      assert Enum.sort(Map.keys(stamped)) == [:badge, :body, :tag, :title, :url]
    end

    test "a zero badge is still stamped explicitly (cleared state)" do
      base = Payload.build(msg(channel: "#sniffo"), "libera", "vjt")
      assert Payload.put_badge(base, 0).badge == 0
    end
  end
end
