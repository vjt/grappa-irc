defmodule Grappa.PubSub do
  @moduledoc """
  Namespace for grappa-internal `Phoenix.PubSub` helpers.

  The atom `Grappa.PubSub` doubles as the registered name of the
  application's `Phoenix.PubSub` server (started under the application
  supervision tree). Erlang/OTP allows the same atom to serve as
  both a module name and a registered process name without conflict —
  module definitions live in the code-server table; registered names
  live in the kernel name table.

  This module exists to host the `Boundary` annotation for the
  `Grappa.PubSub.*` namespace; `Topic` is the only public export.
  """

  use Boundary, top_level?: true, deps: [], exports: [Topic]
end
