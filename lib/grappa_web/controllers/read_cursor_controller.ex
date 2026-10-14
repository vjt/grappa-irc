defmodule GrappaWeb.ReadCursorController do
  @moduledoc """
  Write surface for `Grappa.ReadCursor`.

  ## Single endpoint

  `POST /networks/:network_id/channels/:channel_id/read-cursor` with
  body `{"message_id": <int>}`. Returns 200
  `{"last_read_message_id": <int>}`.

  Monotonic advance-only; the controller is a thin parse + dispatch +
  broadcast layer over `Grappa.ReadCursor.set/4`. A stale (lower) POST
  is clamped by the context and re-affirms the current (higher) cursor,
  so the broadcast below carries the correct id (see #233).

  ## Cross-device broadcast — V4 visitor-parity (2026-05-15)

  After every successful set on EITHER subject kind, the cursor is
  broadcast on the per-channel topic via `ReadCursor.broadcast_set/5`
  (carrying the post-set `badge_count` for the PWA icon badge, door #3)
  so other live cic instances (different tabs / devices) update their
  cursor signal map + icon badge. The set and the fan-out are
  `GrappaWeb.ReadCursorAdvance.advance/4`, the one verb this door shares
  with the own-send door (issue 2407). No batching, no throttle. Visitor topics use
  `"visitor:" <> visitor.id` as the user-name segment — same shape as
  `UserSocket`'s `:user_name` assignment so the broadcast routes to
  the visitor's own user-rooted topic tree.

  Pre-V4 the visitor branch short-circuited to `:ok` with no fan-out
  on the rationale that visitors were single-device (no token reuse
  across browsers). Same-NickServ-identity reuse + multi-tab visitor
  sessions made the no-fan-out a UX gap; the V4 lift restores parity.

  ## Validation

  At-the-boundary per CLAUDE.md:

    * Missing / non-integer / non-positive `message_id` → 400.
    * Channel target invalid (not channel-shaped, not nick-shaped, not
      `$server`) → 400.
    * `message_id` exists but does NOT belong to (subject, network,
      channel) → 422 (caught by `ReadCursor.set/4`'s
      `:invalid_message`). Distinguished from 400 because the request
      shape was valid; the data referenced a different scope.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_target_name: 1]

  alias Grappa.IRC.Identifier
  alias Grappa.Session
  alias GrappaWeb.{ReadCursorAdvance, Subject}

  @doc """
  `POST /networks/:network_id/channels/:channel_id/read-cursor` — set
  the operator's cursor on `(subject, network.id, channel)` to
  `message_id`. Monotonic advance-only via `ReadCursor.set/4` (a lower
  id is clamped to the current cursor).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :invalid_message | :db_unavailable | Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "message_id" => message_id})
      when is_integer(message_id) and message_id > 0 do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_target_name(channel),
         # #537 INC-2.3 — fold the USER-TYPED key to the network's CASEMAPPING
         # at this ingress (after validating the raw input) so the cursor upsert
         # AND the deferred fanout topic/window_counts key match the one key the
         # Server wrote under (rfc1459 `#Foo[1]` → `#foo{1}`). `:ascii` is
         # byte-identical to ReadCursor.set's internal ASCII fold → prod
         # unchanged. Bare `=` with-clause: rebinds `channel` for set + fanout.
         channel = Identifier.canonical_target(channel, Session.casemapping(subject, network.id)),
         # #273 — only the cursor upsert is request-critical. Proven with
         # timing: `ReadCursor.set/4` ~69µs vs a ~10ms+ full
         # `BadgeCount.count/1` fold (EXPLAIN: no covering index for the
         # id-range unread count → the fold scans the network partition per
         # cursored window). Blocking the write on the fold dropped slow POSTs,
         # so cic scrolled back to the stale unread marker. `advance/4` defers
         # the badge + cross-device broadcast to a supervised task, so the
         # response returns right after the (monotonic, #233-clamped) upsert.
         {:ok, cursor} <-
           ReadCursorAdvance.advance(conn.assigns.current_subject, network, channel, message_id) do
      json(conn, %{last_read_message_id: cursor.last_read_message_id})
    end
  end

  def create(_, _), do: {:error, :bad_request}
end
