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
end
