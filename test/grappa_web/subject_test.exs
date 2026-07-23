defmodule GrappaWeb.SubjectTest do
  @moduledoc """
  Unit tests for `GrappaWeb.Subject` — the single source of the
  load-bearing routing invariant "user → `user.name`, visitor →
  `"visitor:" <> id`" (bucket I web/S7). Before this module owned the
  derivation it was copy-pasted across seven web modules; every consumer
  now delegates here, so these tests pin the shape the rest of the web
  layer depends on.
  """
  use ExUnit.Case, async: true

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject

  describe "topic_label/1" do
    test "a user subject derives the bare user name" do
      assert Subject.topic_label({:user, %User{name: "alice"}}) == "alice"
    end

    test "a visitor subject derives the `visitor:` + id segment" do
      assert Subject.topic_label({:visitor, %Visitor{id: "abc-123"}}) == "visitor:abc-123"
    end

    test "raises on a user with no name — a nil name is an invariant violation, not a topic" do
      assert_raise FunctionClauseError, fn ->
        Subject.topic_label({:user, %User{name: nil}})
      end
    end
  end

  describe "from_topic_label/1" do
    test "classifies a `visitor:` prefixed label back to a visitor discriminant" do
      assert Subject.from_topic_label("visitor:abc-123") == {:visitor, "abc-123"}
    end

    test "classifies any other label as a user name" do
      assert Subject.from_topic_label("alice") == {:user, "alice"}
    end

    test "a label that merely contains — but does not start with — the prefix is a user" do
      assert Subject.from_topic_label("not-a-visitor:xyz") == {:user, "not-a-visitor:xyz"}
    end
  end

  describe "label ↔ subject round-trip (the load-bearing prefix invariant)" do
    test "a visitor round-trips through the label and back to its id" do
      visitor = %Visitor{id: "d290f1ee-6c54-4b01-90e6-d701748f0851"}
      label = Subject.topic_label({:visitor, visitor})
      assert Subject.from_topic_label(label) == {:visitor, visitor.id}
    end

    test "a user round-trips through the label and back to its name" do
      user = %User{name: "bob"}
      label = Subject.topic_label({:user, user})
      assert Subject.from_topic_label(label) == {:user, user.name}
    end
  end
end
