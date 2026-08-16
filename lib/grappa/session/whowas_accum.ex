defmodule Grappa.Session.WhowasAccum do
  @moduledoc """
  #1391 — the in-flight `/whowas` accumulator, as a struct.

  One entry of `Session.Server`'s `whowas_pending` map: primed by
  `handle_call({:send_whowas, ...})`, appended to by each 314
  RPL_WHOWASUSER, merged into by the WHOWAS-flavoured 312, and drained on
  369 RPL_ENDOFWHOWAS — or on 406 ERR_WASNOSUCHNICK, which builds a fresh
  `not_found: true` struct rather than draining the primed one.

  Sibling of `Grappa.Session.WhoisAccum`; the rationale for a struct rather
  than a `map()` is written once, there.

  `entries` defaults to `[]`, NOT nil: the prime sets it empty and
  `Wire.whowas_bundle/3` reads it as a list to take the head from. That is
  the opposite of `WhoisAccum`'s `channels` / `extra_lines`, which default
  nil because they ship as JSON `null` — here the list never reaches the
  wire, only its most recent element does.

  Entries are stored REVERSED (head = most recent 314) so the 312 fold into
  the LAST entry is an O(1) head-prepend.
  """

  alias Grappa.Session

  @type t :: %__MODULE__{
          target_display: String.t() | nil,
          entries: [__MODULE__.Entry.t()],
          not_found: boolean(),
          reply_to: Session.reply_to(),
          __primed_at_ms: integer() | nil
        }

  defstruct target_display: nil,
            entries: [],
            not_found: false,
            reply_to: nil,
            __primed_at_ms: nil

  defmodule Entry do
    @moduledoc """
    #1391 — one historical WHOWAS record, as a struct.

    Built by 314 RPL_WHOWASUSER (`user`, `host`, `realname`) and completed
    by the WHOWAS-flavoured 312, which merges `server` + `logoff_time` into
    the most recent entry. `Wire.whowas_bundle/3` projects the head of the
    list; every field is nullable because a stripped-down upstream may omit
    the trailing or never send the 312 at all.

    Nested in its accumulator on purpose: an entry has no meaning outside
    one, and `Deploy.Preflight` collects every `defstruct` in a file, so
    living here inherits the parent's cold-deploy check with no second
    registry entry (measured in `Preflight.collect_state_blocks/1`).
    """

    @type t :: %__MODULE__{
            user: String.t() | nil,
            host: String.t() | nil,
            realname: String.t() | nil,
            server: String.t() | nil,
            logoff_time: String.t() | nil
          }

    defstruct user: nil, host: nil, realname: nil, server: nil, logoff_time: nil
  end
end
