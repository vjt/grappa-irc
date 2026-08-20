defmodule Grappa.SubjectXorTest do
  @moduledoc """
  One table over EVERY schema carrying the subject XOR-FK pair (#1580).

  The census that opened #1580 measured the population closed at twelve on
  four independent axes: twelve `belongs_to :visitor` schemas, twelve
  `case {user_id, visitor_id}` decision bodies (measured by BODY, so an
  inlined or renamed copy could not hide), twelve `*_subject_xor` DB CHECK
  constraints, and zero schemas holding a visitor FK without a decision
  body. Masking the string literals collapsed the twelve bodies to ONE
  control-flow class: the whole divergence in the family was the
  missing-subject message text. `uploads/upload.ex` emitted
  `"one of user_id or visitor_id is required"` where the other eleven
  emitted `"must set user_id or visitor_id"`, three lines under a comment
  claiming it mirrored `ReadCursor.Cursor` — which emits the latter.

  Three schemas of the twelve pinned the missing-subject text and nine did
  not, which is exactly why the drift survived a hand-copy. This table pins
  all twelve on both arms and both valid shapes, so the next copy that
  drifts — or the next call site that quietly stops routing through the
  shared validator — is a red test rather than a silent fork.

  Attrs are deliberately minimal: every assertion reads ONLY the synthetic
  `:subject` key, so the other required fields of each schema are
  irrelevant here and are covered by that schema's own test. The two
  positive assertions (`{nil, nil}` and both-set) are what keeps the pair
  from passing vacuously — a changeset that stopped calling the validator
  altogether would fail them, not slip through the two clean-subject ones.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Accounts.Session
  alias Grappa.ChannelDirectory.Entry, as: DirectoryEntry
  alias Grappa.Networks.Credential
  alias Grappa.Notify.Entry, as: NotifyEntry
  alias Grappa.Push.Subscription
  alias Grappa.QueryWindows.Window
  alias Grappa.ReadCursor.Cursor
  alias Grappa.Scrollback.Message
  alias Grappa.Themes.Theme
  alias Grappa.Uploads.Upload
  alias Grappa.UserSettings.Settings
  alias Grappa.Vhosts.Grant

  @user_id "11111111-1111-4111-8111-111111111111"
  @visitor_id "22222222-2222-4222-8222-222222222222"

  @missing_subject "must set user_id or visitor_id"
  @mutually_exclusive "user_id and visitor_id are mutually exclusive"

  # {schema, its subject-bearing changeset}. Eleven spell it `changeset/2`;
  # `Uploads.Upload` splits insert from soft-delete and only the former
  # casts the subject FKs.
  @xor_schemas [
    {Session, :changeset},
    {Message, :changeset},
    {Cursor, :changeset},
    {Window, :changeset},
    {DirectoryEntry, :changeset},
    {NotifyEntry, :changeset},
    {Subscription, :changeset},
    {Settings, :changeset},
    {Grant, :changeset},
    {Theme, :changeset},
    {Credential, :changeset},
    {Upload, :insert_changeset}
  ]

  describe "the XOR-FK population itself" do
    test "the table covers every schema that declares a visitor FK" do
      # Guards the table against bit-rot: a thirteenth XOR-FK schema added
      # without a row here would otherwise be silently unpinned, which is
      # the failure mode that produced #1580 in the first place.
      declared =
        "lib/grappa/**/*.ex"
        |> Path.wildcard()
        |> Enum.filter(fn path ->
          path |> File.read!() |> String.contains?("belongs_to :visitor,")
        end)

      assert length(declared) == length(@xor_schemas),
             """
             #{length(declared)} schemas declare `belongs_to :visitor`, \
             but the table pins #{length(@xor_schemas)}. Files:
             #{Enum.join(declared, "\n")}
             """
    end
  end

  for {schema, fun} <- @xor_schemas do
    @schema schema
    @fun fun

    describe "#{inspect(schema)}.#{fun}/2 subject XOR" do
      test "neither user_id nor visitor_id attaches the shared missing-subject message" do
        assert @missing_subject in subject_errors(@schema, @fun, %{})
      end

      test "both user_id and visitor_id attaches the shared mutually-exclusive message" do
        errors = subject_errors(@schema, @fun, %{user_id: @user_id, visitor_id: @visitor_id})

        assert @mutually_exclusive in errors
      end

      test "a user-only subject leaves :subject clean" do
        assert subject_errors(@schema, @fun, %{user_id: @user_id}) == []
      end

      test "a visitor-only subject leaves :subject clean" do
        assert subject_errors(@schema, @fun, %{visitor_id: @visitor_id}) == []
      end
    end
  end

  defp subject_errors(schema, fun, attrs) do
    changeset = apply(schema, fun, [struct(schema), attrs])

    changeset
    |> errors_on()
    |> Map.get(:subject, [])
  end
end
