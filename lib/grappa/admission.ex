defmodule Grappa.Admission do
  @moduledoc """
  Admission-control public surface — verbs land in Tasks 10-11.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Visitors],
    exports: [Captcha, NetworkCircuit]
end
