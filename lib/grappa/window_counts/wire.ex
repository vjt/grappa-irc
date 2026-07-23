defmodule Grappa.WindowCounts.Wire do
  @moduledoc """
  Single source of truth for the `window_counts` push event (#267) — the
  server-authoritative per-window `%{messages, mentions, events,
  severity}` snapshot pushed to cicchetto over the per-channel Phoenix
  Channel topic (and folded into the `/me` + `join_reply` seed doors).

  Plain JSON-encodable map (never a struct — `Grappa.PubSub.broadcast_event/2`
  rejects structs at the boundary; raw structs crash the WS fastlane).
  `kind:` is the `"window_counts"` string discriminator cic dispatches
  on. `severity` is kept as the closed `t:Grappa.WindowCounts.severity/0`
  atom and passed through UNCHANGED — `Jason.encode!/1` stringifies it at
  the JSON boundary, and `mix grappa.gen_wire_types` reads the atom union
  from `t/0` to emit a LITERAL TS union (`"mention" | "message" |
  "event" | "none"`) that cic asserts against. Same `server_reply_source`
  precedent as `Scrollback.Wire`'s `kind` (review S14): the atom-through
  form is strictly stronger than an `Atom.to_string/1` boundary that
  would widen to `String.t()` and erase the closed set from codegen.
  """

  alias Grappa.WindowCounts

  @typedoc """
  The `window_counts` broadcast/seed event. `channel` is the (case-folded)
  window key; the four count fields mirror `t:Grappa.WindowCounts.t/0`.
  """
  @type event :: %{
          kind: :window_counts,
          channel: String.t(),
          messages: non_neg_integer(),
          mentions: non_neg_integer(),
          events: non_neg_integer(),
          severity: WindowCounts.severity()
        }

  @doc """
  Builds the `window_counts` event envelope for a `channel` + its count
  snapshot. Use with `Grappa.PubSub.broadcast_event/2` on the per-channel
  topic, or embed under the `/me` + `join_reply` seed.
  """
  @spec window_counts_payload(String.t(), WindowCounts.t()) :: event()
  def window_counts_payload(channel, %{
        messages: messages,
        mentions: mentions,
        events: events,
        severity: severity
      })
      when is_binary(channel) and is_atom(severity) do
    %{
      kind: :window_counts,
      channel: channel,
      messages: messages,
      mentions: mentions,
      events: events,
      severity: severity
    }
  end
end
