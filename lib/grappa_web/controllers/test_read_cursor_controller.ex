if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.TestReadCursorController do
    @moduledoc """
    Test-only write surface that FORCE-sets the read cursor, bypassing
    the monotonic advance-only clamp of the production
    `GrappaWeb.ReadCursorController` (`ReadCursor.set/4`, #233).

    ## Why this exists

    #233 made the production `POST /read-cursor` advance-only: a lower
    id is clamped to the current cursor and never written backward.
    That is correct for production (cic is forward-only; the server is
    the single authoritative regressor). But the e2e cursor / divider /
    scroll specs must PLANT a mid-page (backward) cursor to stage an
    unread-divider scenario — the exact move `set/4` now refuses. Before
    #233 they seeded via the last-write-wins production endpoint; the
    hardening dropped that capability out from under them and the
    `integration` suite went red.

    This endpoint restores the pre-#233 seeding for tests ONLY, WITHOUT
    relaxing the production endpoint. Compile-gated to `:dev`/`:test`
    (the module + its route literally do not exist in the prod release,
    same pattern as `GrappaWeb.Admin.TestResetSubjectController`).

    ## Endpoint

    `POST /networks/:network_id/channels/:channel_id/read-cursor/force`
    with body `{"message_id": <int>}`. Uses the caller's OWN bearer
    (same `[:api, :authn, :resolve_network]` pipeline as the production
    read-cursor route) — no admin token, so the cursor/divider specs
    keep seeding with the seeded user's own token.

    Mirrors `ReadCursorController.create/2` byte-for-byte except it calls
    `ReadCursor.force_set/4` instead of `set/4`. It STILL broadcasts the
    forced id on the per-channel topic via `broadcast_set/5`, because cic
    adopts a backward move ONLY through its authoritative `read_cursor_set`
    WS path (`applyReadCursorSet` is unconditional / last-write-wins) —
    without the fan-out a mid-session seed (cursor-forward-only.spec.ts)
    would never reach the running client.
    """
    use GrappaWeb, :controller

    import GrappaWeb.Validation, only: [validate_target_name: 1]

    alias Grappa.Push.BadgeCount
    alias Grappa.ReadCursor
    alias GrappaWeb.Subject

    @doc """
    `POST /networks/:network_id/channels/:channel_id/read-cursor/force`
    — force the caller-subject's cursor on `(subject, network.id,
    channel)` to `message_id`, bypassing the monotonic clamp. Test-only.
    """
    @spec force(Plug.Conn.t(), map()) ::
            Plug.Conn.t() | {:error, :bad_request | :invalid_message | Ecto.Changeset.t()}
    def force(conn, %{"channel_id" => channel, "message_id" => message_id})
        when is_integer(message_id) and message_id > 0 do
      subject = Subject.to_session(conn.assigns.current_subject)
      network = conn.assigns.network

      with :ok <- validate_target_name(channel),
           {:ok, cursor} <- ReadCursor.force_set(subject, network.id, channel, message_id) do
        badge_count = BadgeCount.count(subject)

        _ =
          maybe_broadcast(
            conn.assigns.current_subject,
            network.slug,
            channel,
            cursor.last_read_message_id,
            badge_count
          )

        json(conn, %{last_read_message_id: cursor.last_read_message_id})
      end
    end

    def force(_, _), do: {:error, :bad_request}

    @spec maybe_broadcast(
            {:user, Grappa.Accounts.User.t()} | {:visitor, Grappa.Visitors.Visitor.t()},
            String.t(),
            String.t(),
            integer(),
            non_neg_integer()
          ) :: :ok | {:error, term()}
    defp maybe_broadcast({:user, user}, network_slug, channel, last_read_message_id, badge_count) do
      ReadCursor.broadcast_set(user.name, network_slug, channel, last_read_message_id, badge_count)
    end

    defp maybe_broadcast(
           {:visitor, visitor},
           network_slug,
           channel,
           last_read_message_id,
           badge_count
         ) do
      ReadCursor.broadcast_set(
        "visitor:" <> visitor.id,
        network_slug,
        channel,
        last_read_message_id,
        badge_count
      )
    end
  end
end
