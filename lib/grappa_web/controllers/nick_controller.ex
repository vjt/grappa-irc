defmodule GrappaWeb.NickController do
  @moduledoc """
  `POST /networks/:network_id/nick` — change the operator's nick on
  the upstream IRC connection.

  ## Subject branching

  Both user and visitor subjects traverse the same path post-V9
  (visitor-parity cluster, 2026-05-15). The visitor short-circuit
  (Q2(a) gate, Task 30) was lifted under the parity invariant: every
  server-side feature surface that branched on subject kind to refuse
  the visitor branch now accepts BOTH branches and dispatches through
  per-subject infrastructure.

  Visitor branch carries one extra step: a `(target_nick, network_slug)`
  pre-check via `Visitors.nick_in_use?/3` BEFORE the upstream NICK
  frame is sent. If another visitor row already holds the target nick
  on the same network, the controller returns 409 `nick_in_use` and
  no NICK frame reaches upstream. The check is fast-path; the
  `(nick, network_slug)` UNIQUE on `visitors` is the second line of
  defense that catches the near-zero-probability concurrent-rename
  race at the EventRouter persist site (logged + dropped per
  `Visitors.update_nick/2`).

  Once the upstream confirms by echoing `:<old> NICK <new>`,
  `Grappa.Session.EventRouter` emits a `{:visitor_nick_changed, new}`
  effect that `Session.Server.apply_effects/2` routes through the
  injected `visitor_nick_persister` callback (mirror of
  `visitor_committer` for +r MODE). User subjects don't carry a
  persister — their nick lives in `Networks.Credential`, which is
  operator-driven.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs (visitor branch
  asserts `network.slug == visitor.network_slug` per W11). The
  `:no_session` tag from `Session.send_nick/3` collapses to the same
  404 wire body via `FallbackController` (S14 oracle close).
  `:invalid_line` (CRLF/NUL byte) collapses to 400 — same envelope
  as for user subjects.

  Cluster: V9 (visitor-parity-and-nickserv).
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.{Session, Visitors}
  alias Grappa.Visitors.Visitor

  @doc """
  `POST /networks/:network_id/nick` — body `{"nick": "newname"}`. Sends
  `NICK <new>` upstream through the session and returns 202 + `{"ok": true}`.
  Empty / non-string nick → 400. `:no_session` / `:invalid_line` collapse
  through `FallbackController` to 404 / 400 respectively. Visitor branch
  adds 409 `nick_in_use` (target collides with another visitor row on
  the same network) + 400 `malformed_nick` (target rejected by
  `IRC.Identifier.valid_nick?/1` at the boundary, since the visitor
  schema's `nick_changeset/2` would reject it later — the controller
  surfaces it now to keep the failure mode consistent with login).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :nick_in_use | :malformed_nick | :no_session | :invalid_line}
  def create(conn, %{"nick" => nick}) when is_binary(nick) and nick != "" do
    case conn.assigns.current_subject do
      {:user, %User{id: user_id}} ->
        network = conn.assigns.network

        with :ok <- Session.send_nick({:user, user_id}, network.id, nick) do
          conn
          |> put_status(:accepted)
          |> json(%{ok: true})
        end

      {:visitor, %Visitor{id: visitor_id} = visitor} ->
        network = conn.assigns.network

        with :ok <- check_visitor_nick(visitor, nick),
             :ok <- Session.send_nick({:visitor, visitor_id}, network.id, nick) do
          conn
          |> put_status(:accepted)
          |> json(%{ok: true})
        end
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # V9 boundary check — surface the syntactic + uniqueness rejections
  # at the controller before the upstream NICK frame goes out. Mirrors
  # the visitor login boundary's `Identifier.valid_nick?/1` shape so
  # the failure modes a visitor sees on /nick match what they saw on
  # initial login.
  @spec check_visitor_nick(Visitor.t(), String.t()) ::
          :ok | {:error, :malformed_nick | :nick_in_use}
  defp check_visitor_nick(%Visitor{id: visitor_id, network_slug: slug}, nick) do
    cond do
      not Grappa.IRC.Identifier.valid_nick?(nick) ->
        {:error, :malformed_nick}

      Visitors.nick_in_use?(visitor_id, nick, slug) ->
        {:error, :nick_in_use}

      true ->
        :ok
    end
  end
end
