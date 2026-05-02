defmodule Grappa.Visitors do
  @moduledoc """
  Visitor context — self-service transient-user lifecycle.

  Stub introduced in Task 2 to host the Boundary annotation that the
  child `Grappa.Visitors.Visitor` schema requires (it cross-calls
  `Grappa.IRC.Identifier` for nick + slug validation). Task 6 expands
  this module with the public CRUD surface
  (`find_or_provision_anon/3`, `commit_password/2`, `touch/1`,
  `count_active_for_ip/1`, `list_active/0`, `list_expired/0`,
  `delete/1`) and grows the Boundary `deps` to add `Grappa.Repo`,
  `Grappa.Accounts`, and `Grappa.Networks` accordingly.
  """

  use Boundary, top_level?: true, deps: [Grappa.IRC], exports: [Visitor]
end
