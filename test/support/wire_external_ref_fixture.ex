defmodule Grappa.WireExternalRefFixture do
  @moduledoc """
  Fixture for the gen_wire_types external-type test. Not used in
  production.

  Mirrors `Grappa.Themes.BuiltinBackgrounds`: a module OUTSIDE the wire
  glob whose public type references a SAME-MODULE `user_type`. The
  external renderer works one alias at a time and keeps no sibling
  registry, so `variant()` must become one more external alias of THIS
  module (issue 2694) rather than a camelized identifier nothing declares
  (#1406 3b).
  """

  @type variant :: :light | :dark

  @type t :: %{
          key: String.t(),
          variant: variant()
        }
end
