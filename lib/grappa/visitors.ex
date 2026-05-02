defmodule Grappa.Visitors do
  @moduledoc """
  Visitor context — self-service transient-user lifecycle management.

  Public API:
  - `Grappa.Visitors.create_visitor/1` — new visitor row.
  - `Grappa.Visitors.commit_password/2` — mark visitor as registered.
  - `Grappa.Visitors.touch_expires_at/2` — slide expiration on activity.
  - `Grappa.Visitors.reap_expired/0` — delete visitors past expiry.
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo, Grappa.IRC], exports: [Visitor]
end
