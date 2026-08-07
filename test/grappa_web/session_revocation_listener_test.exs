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

  alias Grappa.Accounts.Revocations
  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{Endpoint, UserSocket}

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
end
