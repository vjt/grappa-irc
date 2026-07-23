defmodule Grappa.WireFixture do
  @moduledoc "Fixture for gen_wire_types codegen tests. Not used in production."

  @type subject_kind :: :user | :visitor

  @type simple_payload :: %{
          kind: :simple,
          id: integer(),
          name: String.t(),
          maybe_label: String.t() | nil
        }

  @type collection_payload :: %{
          kind: :collection,
          items: [String.t()],
          tags: [subject_kind()]
        }

  # Exercises the codegen's `optional(...)` handling: a server-omitted
  # key must render `key?: T`, not `key: T` (which over-claims the field
  # as always present). See gen_wire_types cross-surface S2.
  @type optional_field_payload :: %{
          required(:always) => String.t(),
          optional(:sometimes) => String.t()
        }
end
