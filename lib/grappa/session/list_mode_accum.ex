defmodule Grappa.Session.ListModeAccum do
  @moduledoc """
  #1391 — the in-flight channel LIST-MODE accumulator, as a struct.

  One entry of `Session.Server`'s `list_mode_pending` map, keyed by
  `{FOLDED channel (#364 channel pattern), mode letter}` so two type-A lists
  of the same channel can stream concurrently. Primed by
  `handle_call({:send_list_mode, ...})`, appended to by each row numeric,
  drained on the end numeric into `{:list_mode_bundle, channel, mode, accum,
  reply_to}` — which `Grappa.Session.Wire.banlist_bundle/4` projects (the
  payload keeps its `b`-era name; see that typedoc).

  Sibling of `Grappa.Session.WhoisAccum`; the rationale for a struct rather
  than a `map()` is written once, there.

  `channel_display` holds the FOLDED channel, not the operator's spelling —
  channels carry no display column under the #537 channel pattern, the
  folded key IS the display. Entries are stored REVERSED for an O(1)
  prepend; `Wire.banlist_bundle/4` reverses.
  """

  alias Grappa.Session
  alias Grappa.Session.ListModes

  @type t :: %__MODULE__{
          channel_display: String.t() | nil,
          mode: ListModes.mode() | nil,
          entries: [__MODULE__.Entry.t()],
          reply_to: Session.reply_to(),
          __primed_at_ms: integer() | nil
        }

  defstruct channel_display: nil,
            mode: nil,
            entries: [],
            reply_to: nil,
            __primed_at_ms: nil

  defmodule Entry do
    @moduledoc """
    #1391 — one row of a type-A channel list, as a struct.

    Built by 367 RPL_BANLIST / 348 / 346 / 728, which carry `setter` and
    `set_ts` OPTIONALLY — older ircds and solanum send the mask alone, so
    both stay nullable. `set_ts` is the RAW upstream epoch STRING, shipped
    verbatim: cic formats it to the viewer's locale
    (`feedback_no_localized_strings_server_side`).

    Projected by `Wire.banlist_bundle/4` into the `banlist_entry/0` WIRE
    shape, which stays a plain map — the payload is what the TS codegen
    reads and what Jason encodes. This struct is the internal accumulator
    shape; they are deliberately two things.

    Nested in its accumulator on purpose — see `WhowasAccum.Entry`.
    """

    @type t :: %__MODULE__{
            mask: String.t() | nil,
            setter: String.t() | nil,
            set_ts: String.t() | nil
          }

    defstruct mask: nil, setter: nil, set_ts: nil
  end
end
