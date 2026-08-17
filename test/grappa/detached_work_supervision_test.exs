defmodule Grappa.DetachedWorkSupervisionTest do
  @moduledoc """
  The work handed off the session hot path belongs to the application's
  task supervisor, not to nobody.

  Three places take work off the session process so the session is not
  blocked by it. Being SUPERVISED and being BOUNDED are different
  properties, and only the first is asserted here: a supervised worker is
  visible to the operator, its crash is a report instead of a silent
  disappearance, and it is attached to a place where a ceiling could later
  be configured. **It is not itself a ceiling.** Nothing in the tree
  configures one, and this file deliberately asserts nothing about how
  many workers may exist at once — an assertion of that kind would claim
  a control the code does not have.

  ## Why each test holds its worker still

  A worker that has already finished looks exactly like one that was never
  supervised: the supervisor's child list is empty either way. So each
  test parks its worker and asks the supervisor while it is parked.

  The two paths park in different places, because they block on different
  things, and both parks are real infrastructure rather than a stand-in
  for the thing under test:

    * the window-counts worker resolves a live member count, which is a
      call into the session — so a process registered where the session
      would be, which never answers, parks it;

    * the notification workers consult the presence singleton before they
      fan out — so suspending that singleton with OTP's own `:sys.suspend/1`
      parks them. Their preferences are set so the predicate ahead of that
      consultation is true; otherwise the worker would short-circuit and
      retire before it could be observed.

  `async: false` — parks a node-wide singleton and reads a supervisor
  every other test also feeds.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{AuthFixtures, ScrollbackHelpers, UserSettings, WSPresence}
  alias Grappa.Push.Triggers
  alias Grappa.Scrollback.Message
  alias Grappa.Session.Server
  alias Grappa.WindowCounts.Pusher

  @channel "#chan"
  @own_nick "vjt"
  @peer "alice"

  setup do
    user = AuthFixtures.user_fixture()
    network = AuthFixtures.network_fixture()
    subject = {:user, user.id}

    :ok = WSPresence.reset_for_test()
    :ok = WSPresence.register(user.name, self())

    on_exit(fn ->
      resume_presence()
      WSPresence.reset_for_test()
    end)

    %{user: user, network: network, subject: subject, label: user.name}
  end

  test "the window-counts worker runs under the task supervisor", ctx do
    {:ok, _} =
      ScrollbackHelpers.insert(%{
        user_id: ctx.user.id,
        network_id: ctx.network.id,
        channel: @channel,
        server_time: System.unique_integer([:positive]),
        kind: :privmsg,
        sender: @peer,
        body: "hi"
      })

    park_session(ctx.subject, ctx.network.id)

    :ok =
      Pusher.push(%{
        subject: ctx.subject,
        network_id: ctx.network.id,
        network_slug: ctx.network.slug,
        subject_label: ctx.label,
        channel: @channel,
        own_nick: @own_nick
      })

    # The parked worker names ITSELF: the stand-in reports the pid blocked
    # inside the call. Identity, not a count — a count is inflated by a
    # worker another test left dying, which is exactly what made an earlier
    # version of this test fail while the code was already correct.
    assert_receive {:worker_parked, worker}, 2_000

    assert MapSet.member?(supervised_pids(), worker),
           "the window-counts worker is not a child of the task supervisor"
  end

  test "the message-notification worker runs under the task supervisor", ctx do
    set_pref(ctx.subject, :private_messages_all, true)

    park_presence()
    before = supervised_pids()

    :ok = Triggers.evaluate_and_dispatch(inbound_dm(ctx), trigger_ctx(ctx))

    assert_supervised_worker_appears(before, "message-notification")
  end

  test "the presence-notification worker runs under the task supervisor", ctx do
    set_pref(ctx.subject, :presence_online, true)

    park_presence()
    before = supervised_pids()

    :ok = Triggers.dispatch_presence(@peer, :online, :transition, trigger_ctx(ctx))

    assert_supervised_worker_appears(before, "presence-notification")
  end

  # The setter validates the WHOLE preference map, so flipping one key
  # means reading the current map through the same context that writes it
  # rather than hand-rolling a literal here — a literal would be a second
  # copy of the defaults, silently stale the day one of them changes.
  defp set_pref(subject, key, value) do
    prefs =
      subject
      |> UserSettings.get_notification_prefs()
      |> Map.put(key, value)

    {:ok, _} = UserSettings.put_notification_prefs(subject, prefs)
    :ok
  end

  # A SET, not a count. Another test's worker can still be dying while this
  # one starts; a count cannot tell "one arrived" from "one left".
  defp supervised_pids do
    Grappa.TaskSupervisor
    |> Task.Supervisor.children()
    |> MapSet.new()
  end

  # An inbound DM: `channel` carries the own nick, which is what marks the
  # row as a DM to the notification predicate, and the sender is someone
  # else so the own-row exclusion does not fire.
  defp inbound_dm(ctx) do
    %Message{
      kind: :privmsg,
      channel: @own_nick,
      dm_with: @peer,
      sender: @peer,
      body: "ping",
      network_id: ctx.network.id,
      server_time: DateTime.utc_now()
    }
  end

  defp trigger_ctx(ctx) do
    %{
      subject: ctx.subject,
      subject_label: ctx.label,
      network_slug: ctx.network.slug,
      own_nick: @own_nick
    }
  end

  # Registered where the session would be; answers nothing, so the caller
  # stays inside its call for as long as the test needs it there.
  defp park_session(subject, network_id) do
    key = Server.registry_key(subject, network_id)
    ready = self()

    pid =
      spawn(fn ->
        {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
        send(ready, :parker_ready)
        park_loop(ready)
      end)

    assert_receive :parker_ready, 1_000
    on_exit(fn -> Process.exit(pid, :kill) end)
    pid
  end

  defp park_loop(notify) do
    receive do
      {:"$gen_call", {caller, _}, {:list_members, _}} ->
        send(notify, {:worker_parked, caller})
        park_loop(notify)

      _ ->
        park_loop(notify)
    end
  end

  # OTP's own suspend: the singleton stops serving calls, so anything that
  # consults it waits. Not a stub — the real process, held.
  defp park_presence do
    WSPresence |> Process.whereis() |> :sys.suspend()
  end

  defp resume_presence do
    case Process.whereis(WSPresence) do
      nil -> :ok
      pid -> :sys.resume(pid)
    end
  end

  # These workers give no signal of their own, so there is nothing to wait
  # for that is independent of the property under test: the appearance of a
  # supervised child IS the assertion, and its absence within the window is
  # the failure. Deliberately NOT followed by a second `assert` on the same
  # count — that assert could never fail, and a pair of statements where one
  # cannot fail reads like two checks while being one.
  #
  # Polled rather than slept on: a fixed sleep would be a guess about spawn
  # latency, and the guess would decide the verdict on a loaded machine.
  defp assert_supervised_worker_appears(before, which),
    do: assert_supervised_worker_appears(before, which, 200)

  defp assert_supervised_worker_appears(_, which, 0) do
    flunk("the #{which} worker is not a child of the task supervisor")
  end

  defp assert_supervised_worker_appears(before, which, attempts) do
    if MapSet.difference(supervised_pids(), before) |> Enum.any?() do
      :ok
    else
      Process.sleep(10)
      assert_supervised_worker_appears(before, which, attempts - 1)
    end
  end
end
