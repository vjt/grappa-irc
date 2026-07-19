defmodule Grappa.WindowCountsTest do
  @moduledoc """
  Server-authoritative per-window unread/mention/severity snapshot
  (#267). `snapshot/6` derives `%{messages, mentions, events,
  severity}` for a `(subject, network, channel)` window from the read
  cursor + the messages table — no persisted counter, no client
  compute.

  Coverage: the content/presence split (messages vs events, #265),
  the mention subset (`Mentions.mentioned?/3` SSOT via own_nick +
  highlight patterns), own-sender exclusion (you cannot mention
  yourself), the severity ladder (mention > message > event > none),
  nil-cursor (count from 0), past-tail (all zero), and the mention
  scan cap.

  `async: true` — every test mints fresh rows; `snapshot/6` is a pure
  read over sandboxed Repo state.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{AuthFixtures, ScrollbackHelpers, WindowCounts}

  defp uniq, do: System.unique_integer([:positive])

  defp ctx do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()
    %{subject: {:user, user.id}, network: network}
  end

  # Inserts one row, returns the persisted `%Message{}`.
  defp insert(ctx, channel, opts) do
    attrs =
      reject_nil(%{
        user_id: elem(ctx.subject, 1),
        network_id: ctx.network.id,
        channel: channel,
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: Keyword.get(opts, :body, "hello"),
        dm_with: opts[:dm_with]
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  defp reject_nil(map), do: :maps.filter(fn _, v -> v != nil end, map)

  # snapshot with no highlight patterns unless overridden.
  defp snap(ctx, channel, cursor, own_nick, patterns \\ []) do
    WindowCounts.snapshot(ctx.subject, ctx.network.id, channel, cursor, own_nick, patterns)
  end

  # ---------------------------------------------------------------------------
  # Empty / past-tail
  # ---------------------------------------------------------------------------

  test "empty window returns all-zero, severity :none" do
    c = ctx()
    assert snap(c, "#chan", 0, "vjt") == %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  test "cursor at the tail returns all-zero, severity :none" do
    c = ctx()
    insert(c, "#chan", st: 1, body: "a")
    last = insert(c, "#chan", st: 2, body: "b")
    assert snap(c, "#chan", last.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 0, severity: :none}
  end

  # ---------------------------------------------------------------------------
  # messages vs events split (#265)
  # ---------------------------------------------------------------------------

  test "content messages count under :messages, severity :message" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "one")
    insert(c, "#chan", st: 3, sender: "bob", body: "two")

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 2, mentions: 0, events: 0, severity: :message}
  end

  test "presence/control events count under :events only, severity :event" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "bob", kind: :join, body: nil)
    insert(c, "#chan", st: 3, sender: "bob", kind: :part, body: nil)
    insert(c, "#chan", st: 4, sender: "bob", kind: :mode, body: nil)

    assert snap(c, "#chan", anchor.id, "vjt") ==
             %{messages: 0, mentions: 0, events: 3, severity: :event}
  end

  test "join/part churn alone never escalates above :event (#265)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    for i <- 2..10, do: insert(c, "#chan", st: i, sender: "bob", kind: :join, body: nil)

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 0
    assert result.severity == :event
  end

  # ---------------------------------------------------------------------------
  # mention subset — Mentions.mentioned?/3 SSOT
  # ---------------------------------------------------------------------------

  test "nick mention at word boundary counts under :mentions, severity :mention" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "morning all")
    insert(c, "#chan", st: 3, sender: "bob", body: "hey vjt ping")
    insert(c, "#chan", st: 4, sender: "dave", body: "vjt: around?")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 3
    assert result.mentions == 2
    assert result.severity == :mention
  end

  test "substring is not a mention (word-boundary)" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "vjt123 is a different nick")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 1
    assert result.mentions == 0
    assert result.severity == :message
  end

  test "highlight patterns also produce mentions, not just own_nick" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "i love grappa")
    insert(c, "#chan", st: 3, sender: "bob", body: "ping vjt")
    insert(c, "#chan", st: 4, sender: "carol", body: "unrelated")

    result = snap(c, "#chan", anchor.id, "vjt", ["grappa"])
    assert result.messages == 3
    assert result.mentions == 2
    assert result.severity == :mention
  end

  test "own-sent message naming own nick is NOT a self-mention" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # Own message that happens to contain own nick (e.g. quoting).
    insert(c, "#chan", st: 2, sender: "vjt", body: "as vjt i say hi")
    # A real mention from someone else.
    insert(c, "#chan", st: 3, sender: "bob", body: "vjt you there")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result.messages == 2
    assert result.mentions == 1
    assert result.severity == :mention
  end

  test "own-sender fold respects rfc1459 casemapping" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    # own_nick "foo[bar]"; own-sent under rfc1459-equivalent "foo{bar}".
    insert(c, "#chan", st: 2, sender: "foo{bar}", body: "foo[bar] wrote this")

    result = snap(c, "#chan", anchor.id, "foo[bar]")
    assert result.mentions == 0
  end

  # ---------------------------------------------------------------------------
  # severity ladder
  # ---------------------------------------------------------------------------

  test "mention outranks message and event in a mixed window" do
    c = ctx()
    anchor = insert(c, "#chan", st: 1, body: "anchor")
    insert(c, "#chan", st: 2, sender: "alice", body: "plain msg")
    insert(c, "#chan", st: 3, sender: "bob", kind: :join, body: nil)
    insert(c, "#chan", st: 4, sender: "carol", body: "vjt ping")

    result = snap(c, "#chan", anchor.id, "vjt")
    assert result == %{messages: 2, mentions: 1, events: 1, severity: :mention}
  end

  # ---------------------------------------------------------------------------
  # nil cursor — count from 0
  # ---------------------------------------------------------------------------

  test "nil cursor counts every row from the beginning" do
    c = ctx()
    insert(c, "#chan", st: 1, sender: "alice", body: "a")
    insert(c, "#chan", st: 2, sender: "bob", body: "vjt hi")

    result = snap(c, "#chan", nil, "vjt")
    assert result.messages == 2
    assert result.mentions == 1
    assert result.severity == :mention
  end
end
