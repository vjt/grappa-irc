defmodule GrappaWeb.BoundaryTest do
  use ExUnit.Case, async: true

  test "GrappaWeb Boundary deps include Grappa.Admission" do
    [%{opts: opts}] = Keyword.fetch!(GrappaWeb.__info__(:attributes), Boundary)
    deps = Keyword.get(opts, :deps, [])

    assert Grappa.Admission in deps,
           "expected Grappa.Admission in GrappaWeb Boundary deps, got: #{inspect(deps)}"
  end
end
