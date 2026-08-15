defmodule GrappaWeb.SessionRevocationListenerTest do
  @moduledoc """
  The web half of the revocation contract: an announcement must reach the
  socket id-topic Phoenix's transport process is subscribed to.

  Deliberately drives the AMBIENT listener from the application tree
  rather than starting a private one. Standing up an isolated instance
  would prove the module works and say nothing about whether it is
  wired — and "wired at every door" is the whole defect. If the child is
  dropped from `Grappa.Application`, this goes red.

  The id-topic is built with `UserSocket.id_for_subject/1`, not a literal:
  the assertion has to fail when the id shape changes, not silently pass
  against a stale copy of it.
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Grappa.Accounts.{Revocations, User}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{Endpoint, SessionRevocationListener, UserSocket}

  test "a user announcement pushes disconnect on that user's socket id-topic" do
    name = "revoked-#{System.unique_integer([:positive])}"
    socket_id = UserSocket.id_for_subject({:user, %User{name: name}})
    :ok = Endpoint.subscribe(socket_id)

    :ok = Revocations.announce({:user, name})

    assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
  end

  test "a visitor announcement pushes disconnect on the visitor's socket id-topic" do
    id = Ecto.UUID.generate()
    socket_id = UserSocket.id_for_subject({:visitor, %Visitor{id: id}})
    :ok = Endpoint.subscribe(socket_id)

    :ok = Revocations.announce({:visitor, id})

    assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
  end

  test "an announcement for one subject leaves another subject's socket alone" do
    bystander = "bystander-#{System.unique_integer([:positive])}"
    socket_id = UserSocket.id_for_subject({:user, %User{name: bystander}})
    :ok = Endpoint.subscribe(socket_id)

    :ok = Revocations.announce({:user, "revoked-#{System.unique_integer([:positive])}"})

    refute_receive %Phoenix.Socket.Broadcast{topic: ^socket_id}, 100
  end

  # #1338 M-S2 — an unrecognised message must not cost the process. The
  # teardown guarantee is what this listener exists for, so the test
  # asserts BOTH halves in one go: the unknown message is survived AND a
  # real revocation immediately after it still reaches the id-topic. A
  # test that only proved survival would be satisfied by a listener that
  # survived by no longer listening.
  test "an unmodelled message is logged, and a real revocation still tears down" do
    pid = Process.whereis(SessionRevocationListener)
    assert is_pid(pid), "the ambient listener must be in the application tree"
    ref = Process.monitor(pid)

    name = "revoked-#{System.unique_integer([:positive])}"
    socket_id = UserSocket.id_for_subject({:user, %User{name: name}})
    :ok = Endpoint.subscribe(socket_id)

    log =
      capture_log(fn ->
        send(pid, {:sessions_revoked_v2, {:user, name}, :a_field_this_version_never_heard_of})

        :ok = Revocations.announce({:user, name})

        assert_receive %Phoenix.Socket.Broadcast{topic: ^socket_id, event: "disconnect"}
      end)

    refute_receive {:DOWN, ^ref, :process, ^pid, _}, 100
    assert log =~ "unexpected mailbox message"
  end
end
