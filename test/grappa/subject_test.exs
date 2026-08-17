defmodule Grappa.SubjectTest do
  @moduledoc """
  Tests for the subject-label codec (#413) and the fail-loud posture of
  `subject_where/2` (#1392).

  `label/1` + `from_label/1` are the single source of truth for the
  user-rooted topic-label encoding — `user.name` for users,
  `"visitor:" <> id` for visitors — previously restated at ~6 call
  sites plus one inverse parser. The failure mode this pins is a
  silent dead-drop on drift: a subject that no longer round-trips
  does not raise, it just stops matching, far from the cause. The
  property test is exactly the shape an encode/decode pair calls for.

  `subject_where/2`'s happy path is not restated here: it is exercised
  by the 38 call sites across nine contexts, whose own context tests
  run real queries and would go red on a swapped FK column. What those
  call sites do NOT pin is the off-domain clause, which is the one
  `Grappa.Scrollback` used to own alone.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.ReadCursor.Cursor
  alias Grappa.Subject

  describe "label/1" do
    test "user → bare name" do
      assert Subject.label({:user, "alice"}) == "alice"
    end

    test "visitor → \"visitor:\" <> id" do
      assert Subject.label({:visitor, "9a3f-uuid"}) == "visitor:9a3f-uuid"
    end
  end

  describe "from_label/1" do
    test "\"visitor:\" <> id → {:visitor, id}" do
      assert Subject.from_label("visitor:9a3f-uuid") == {:visitor, "9a3f-uuid"}
    end

    test "bare name → {:user, name}" do
      assert Subject.from_label("alice") == {:user, "alice"}
    end
  end

  describe "round-trip (property)" do
    property "user names survive label |> from_label" do
      check all(name <- user_name()) do
        assert Subject.from_label(Subject.label({:user, name})) == {:user, name}
      end
    end

    property "visitor ids survive label |> from_label" do
      check all(id <- visitor_id()) do
        assert Subject.from_label(Subject.label({:visitor, id})) == {:visitor, id}
      end
    end
  end

  # #1392 — the fall-through promoted here from
  # `Grappa.Scrollback.subject_where/2` (added by B5.4 L-pers-2). It is
  # the ONE clause the three former spellings disagreed on: `Scrollback`
  # raised `ArgumentError` naming the offending value, `Grappa.Subject`
  # and `Grappa.ReadCursor` fell through to a `FunctionClauseError`
  # whose Erlang-level message hides both the value and the function.
  # Folding the two privates into this module without the fall-through
  # would have been a diagnostic regression at 12 call sites, so the
  # clause travels WITH the function.
  #
  # These assert the inspected value is IN the message, not merely that
  # something raised: naming the subject is the entire reason the clause
  # exists over a bare pattern-match failure.
  describe "subject_where/2 — fail-loud off the valid domain (#1392)" do
    test "an unknown discriminator raises ArgumentError naming the subject" do
      assert_raise ArgumentError, ~r/unknown subject: \{:typo, "x"\}/, fn ->
        Subject.subject_where(Cursor, {:typo, "x"})
      end
    end

    test "a nil subject raises ArgumentError naming the subject" do
      assert_raise ArgumentError, ~r/unknown subject: nil/, fn ->
        Subject.subject_where(Cursor, nil)
      end
    end

    test "a well-tagged subject with a non-binary id raises ArgumentError naming it" do
      assert_raise ArgumentError, ~r/unknown subject: \{:user, nil\}/, fn ->
        Subject.subject_where(Cursor, {:user, nil})
      end
    end
  end

  # Grappa user names match `^[a-zA-Z][a-zA-Z0-9_\-]*$`
  # (`Grappa.Accounts.User` @name_format) — a leading letter then
  # alphanumeric/_/-, never a colon. That charset is what makes the
  # bare-name encoding unambiguous: a valid name can never collide
  # with the `"visitor:"` prefix, so the round-trip holds by domain.
  defp user_name do
    gen all(
          first <- string([?a..?z, ?A..?Z], length: 1),
          rest <- string([?a..?z, ?A..?Z, ?0..?9, ?_, ?-], max_length: 30)
        ) do
      first <> rest
    end
  end

  # Visitor ids are `Ecto.UUID` strings in production; the prefix
  # strip is exact, so ANY binary round-trips — UUIDs are the honest
  # domain.
  defp visitor_id, do: StreamData.repeatedly(&Ecto.UUID.generate/0)
end
