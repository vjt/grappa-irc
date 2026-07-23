defmodule Grappa.WindowCounts.PusherTest do
  @moduledoc """
  Default `window_counts` push impl (#267).

  `emit/1` (synchronous) computes the fresh snapshot and broadcasts the
  `window_counts` event on the per-channel topic. `push/1` gates on live
  WS presence and does the work in a Task.

  ## Test isolation

  `async: false` — touches the `Grappa.WSPresence` singleton and spawns a
  Task that queries the Repo (needs the shared sandbox the async:false lane
  provides). Respects `config :ex_unit, max_cases: 1`.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{AuthFixtures, ScrollbackHelpers, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.WindowCounts.Pusher

  defp uniq, do: System.unique_integer([:positive])

  setup do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()
    subject = {:user, user.id}
    # subject_label for a user is user.name (mirrors Session.Server state).
    label = user.name
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.channel(label, network.slug, "#chan"))
    %{user: user, network: network, subject: subject, label: label}
  end

  defp insert(ctx, opts) do
    {:ok, m} =
      ScrollbackHelpers.insert(%{
        user_id: elem(ctx.subject, 1),
        network_id: ctx.network.id,
        channel: "#chan",
        server_time: opts[:st] || uniq(),
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: Keyword.get(opts, :body, "hi")
      })

    m
  end

  defp push_ctx(ctx) do
    %{
      subject: ctx.subject,
      network_id: ctx.network.id,
      network_slug: ctx.network.slug,
      subject_label: ctx.label,
      channel: "#chan",
      own_nick: "vjt"
    }
  end

  test "emit/1 broadcasts the fresh window_counts snapshot on the channel topic", ctx do
    anchor = insert(ctx, st: 1, body: "anchor")
    insert(ctx, st: 2, sender: "alice", body: "plain")
    insert(ctx, st: 3, sender: "bob", body: "vjt ping")
    {:ok, _} = Grappa.ReadCursor.set(ctx.subject, ctx.network.id, "#chan", anchor.id)

    :ok = Pusher.emit(push_ctx(ctx))

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{
                       kind: :window_counts,
                       channel: "#chan",
                       messages: 2,
                       mentions: 1,
                       events: 0,
                       severity: :mention
                     }
                   },
                   1_000
  end

  test "push/1 skips the broadcast when no WS is connected", ctx do
    insert(ctx, st: 1, sender: "alice", body: "hi")

    :ok = Pusher.push(push_ctx(ctx))

    refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_counts}}, 300
  end

  test "push/1 broadcasts when a WS is connected for the subject", ctx do
    insert(ctx, st: 1, sender: "bob", body: "vjt hi")
    :ok = WSPresence.register(ctx.label, self())

    :ok = Pusher.push(push_ctx(ctx))

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{kind: :window_counts, messages: 1, mentions: 1, severity: :mention}
                   },
                   1_000
  end
end
