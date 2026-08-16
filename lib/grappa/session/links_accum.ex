defmodule Grappa.Session.LinksAccum do
  @moduledoc """
  #1391 — the in-flight `/links` accumulator, as a struct.

  `Session.Server`'s `links_pending`: `nil` when idle, a struct once
  `handle_call({:send_links, ...})` primes it. 364 RPL_LINKS prepends an
  entry, 365 RPL_ENDOFLINKS drains it into `{:links_bundle, accum,
  reply_to}`. Unkeyed (one topology per network), so it never passes through
  `prime_pending/3` and carries no `__primed_at_ms` — `requested_at` is its
  own staleness stamp, read by the #513b re-prime gate.

  Sibling of `Grappa.Session.WhoisAccum`; the rationale for a struct rather
  than a `map()` is written once, there.

  `requested_at` stays `integer() | nil` and the #513b gate keeps its
  `is_integer(ts)` guard: `now - nil` raises and `n < nil` is `true` under
  Erlang term order, so the guard is load-bearing, not decoration.

  `mask` is `nil` for a full-mesh request and rides to the client so cic can
  tell "mask matched nothing" from "topology restricted" (#513a). Entries
  are stored REVERSED for an O(1) prepend; `Wire.links_bundle/2` reverses.
  """

  alias Grappa.Session

  @type t :: %__MODULE__{
          entries: [__MODULE__.Entry.t()],
          mask: String.t() | nil,
          requested_at: integer() | nil,
          reply_to: Session.reply_to()
        }

  defstruct entries: [],
            mask: nil,
            requested_at: nil,
            reply_to: nil

  defmodule Entry do
    @moduledoc """
    #1391 — one 364 RPL_LINKS topology row, as a struct.

    `server` is the node, `linked_to` its uplink; the root self-links
    (`server == linked_to`, `hopcount == 0`). `hopcount` and `description`
    are nil only when the upstream trailing is malformed — the parse is
    defensive, so the nullability is real rather than theoretical.

    Projected by `Wire.links_bundle/2` into the `links_entry/0` WIRE shape,
    which stays a plain map (payload = what the codegen reads and Jason
    encodes). cic reconstructs the spanning tree from the `linked_to`
    parent edges: the typed bundle IS the tree, cic never parses IRC.

    Nested in its accumulator on purpose — see `WhowasAccum.Entry`.
    """

    @type t :: %__MODULE__{
            server: String.t() | nil,
            linked_to: String.t() | nil,
            hopcount: integer() | nil,
            description: String.t() | nil
          }

    defstruct server: nil, linked_to: nil, hopcount: nil, description: nil
  end
end
