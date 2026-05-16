defmodule Grappa.Visitors.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Visitors.Visitor` rows
  (M-cluster M-4 `GET /admin/visitors`). Sibling to
  `Grappa.Visitors.Wire`, which serves cic/auth-facing surfaces.

  ## Why two wire modules

  `Visitors.Wire` is the redact-protected door for the public profile
  + credential-exchange shapes. It deliberately excludes operator-only
  fields (`:ip`, `:inserted_at`) per its moduledoc. The admin console
  needs those fields PLUS the live BEAM state join — they don't
  belong on the public wire.

  Splitting AdminWire from Wire keeps the public Wire's allowlist
  contract tight: a future cic feature that wants visitor IP for some
  reason would be a deliberate edit to Wire, not a side-effect of
  reusing the admin shape. Same pattern as
  `Grappa.Networks.Wire` ↔ (future) `Grappa.Networks.AdminWire`.

  ## Defensive field exclusion (CRITICAL)

  `:password_encrypted` is NEVER in the rendered map. Cloak decrypts
  on read — naive `Jason.encode!/1` would leak the upstream NickServ
  password. Same defense Wire's moduledoc documents at length.
  Adding fields to this shape = edit one site (this module) with
  explicit per-field projection.

  ## Shape note vs MD2 plan example

  MD2 (`docs/plans/2026-05-16-tmu-cluster-arc.md` lines 632-661)
  shows visitors wrapped under a `db_state: {...}` key alongside
  `live_state: {...}`. The actual wire flattens visitor fields to
  the top level — the visitor schema IS the DB intent, so a
  separate `db_state` wrapper would be empty ceremony. The
  `live_state: nil` U-0 honesty signal still surfaces at the same
  field name; nothing operational is lost in the flattening.

  ## Live-state join shape

  Caller (`Grappa.Visitors.list_all_with_live_state/0`) attaches the
  `Grappa.LiveIntrospection.SessionEntry` (or `nil` when no live
  pid). `live_state: nil` IS the U-0 honesty signal — the admin
  console renders that prominently so the operator sees "DB intent
  exists, BEAM doesn't."
  """

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Visitors.Visitor

  @type live_state_json :: %{
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type t :: %{
          id: Ecto.UUID.t(),
          nick: String.t(),
          network_slug: String.t(),
          expires_at: DateTime.t() | nil,
          identified: boolean(),
          ip: String.t() | nil,
          inserted_at: DateTime.t(),
          live_state: live_state_json() | nil
        }

  @doc """
  Render a visitor row + optional live state to the admin JSON
  shape. `live` is `nil` when no `Session.Server` is registered for
  `{:visitor, v.id} × network.id` — the U-0 honesty signal.
  """
  @spec visitor_to_admin_json(Visitor.t(), SessionEntry.t() | nil) :: t()
  def visitor_to_admin_json(%Visitor{} = v, live) do
    %{
      id: v.id,
      nick: v.nick,
      network_slug: v.network_slug,
      expires_at: v.expires_at,
      identified: is_nil(v.expires_at),
      ip: v.ip,
      inserted_at: v.inserted_at,
      live_state: live_state_to_json(live)
    }
  end

  defp live_state_to_json(nil), do: nil

  defp live_state_to_json(%SessionEntry{} = entry) do
    %{
      alive: entry.alive,
      pid_inspect: inspect(entry.pid),
      mailbox_len: entry.mailbox_len,
      memory_bytes: entry.memory_bytes,
      joined_channels: entry.joined_channels,
      introspection_degraded: entry.introspection_degraded
    }
  end
end
