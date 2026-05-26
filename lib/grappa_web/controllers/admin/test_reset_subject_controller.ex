if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.Admin.TestResetSubjectController do
    @moduledoc """
    Test-only admin endpoint that drains every mutable surface for a
    seed user (delegates to `Grappa.TestSupport.SubjectReset`).
    Compile-gated to `:dev` and `:test` envs; module + route literally
    do not exist in the prod release.

    Wired at `POST /admin/test/reset-subject` under the
    `[:api, :authn, :admin_authn]` pipeline — requires an admin
    bearer token.

    Body: `{"user_name": "vjt", "baseline_autojoin": {"bahamut-test": ["#bofh"]}}`.
    `baseline_autojoin` is optional — when omitted, credentials keep
    their current `autojoin_channels` (only `last_joined_channels` is
    cleared). The fixture supplies the seed-time autojoin per network
    so DELETE-driven mutations to operator-config autojoin (cic's
    PART verb, exercised by UX-1, m9-part-x-click, cp15-b6) get
    restored across specs.

    See `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`.
    """
    use GrappaWeb, :controller

    alias Grappa.TestSupport.SubjectReset

    @spec reset(Plug.Conn.t(), map()) :: Plug.Conn.t()
    @doc """
    `POST /admin/test/reset-subject` action. Drains every mutable
    surface for `params["user_name"]` via
    `Grappa.TestSupport.SubjectReset.reset!/2` and returns 204.

    Inline error dispatch (not `action_fallback`) — three of four
    error tuples carry slug/reason payloads only this surface knows
    about; FallbackController would have to grow test-only clauses
    for them.
    """
    def reset(conn, %{"user_name" => user_name} = params) when is_binary(user_name) do
      # Inline dispatch (not action_fallback) — three of four error
      # tuples carry slug/reason payloads only this surface knows
      # about; FallbackController would have to grow test-only clauses
      # for them.
      opts = build_opts(params)

      case SubjectReset.reset!(user_name, opts) do
        :ok ->
          send_resp(conn, 204, "")

        {:error, :user_not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "user_not_found"})

        {:error, {:reconnect_timeout, slug}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{error: "session_reconnect_timeout", network_slug: slug})

        {:error, {:reconnect_failed, slug, reason}} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "session_reconnect_failed", network_slug: slug, reason: inspect(reason)})

        {:error, {:autojoin_timeout, slug, channels}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{
            error: "autojoin_timeout",
            network_slug: slug,
            missing_channels: channels
          })
      end
    end

    def reset(conn, _) do
      conn |> put_status(:unprocessable_entity) |> json(%{error: "user_name_required"})
    end

    # Coerce the JSON `baseline_autojoin` map into the keyword-shaped
    # opts SubjectReset.reset!/2 expects. Reject non-map / non-list
    # values silently — defaulting to "no baseline" is safer than
    # 422'ing a malformed body that an older fixture might send.
    defp build_opts(params) when is_map(params) do
      %{}
      |> maybe_put_autojoin(params)
      |> maybe_put_seed(params)
    end

    defp maybe_put_autojoin(opts, %{"baseline_autojoin" => baseline}) when is_map(baseline) do
      sanitized =
        baseline
        |> Enum.flat_map(fn
          {slug, channels} when is_binary(slug) and is_list(channels) ->
            chans = Enum.filter(channels, &is_binary/1)
            [{slug, chans}]

          _ ->
            []
        end)
        |> Map.new()

      Map.put(opts, :baseline_autojoin, sanitized)
    end

    defp maybe_put_autojoin(opts, _), do: opts

    defp maybe_put_seed(opts, %{"baseline_seed" => baseline}) when is_map(baseline) do
      sanitized =
        baseline
        |> Enum.flat_map(fn
          {slug, channels} when is_binary(slug) and is_list(channels) ->
            chans = Enum.flat_map(channels, &normalise_channel_spec/1)
            [{slug, chans}]

          _ ->
            []
        end)
        |> Map.new()

      Map.put(opts, :baseline_seed, sanitized)
    end

    defp maybe_put_seed(opts, _), do: opts

    defp normalise_channel_spec(%{"name" => name} = entry) when is_binary(name) do
      count = entry |> Map.get("seed_count", 0) |> coerce_count()
      sender = entry |> Map.get("seed_sender", "seed-bot") |> coerce_sender()
      [%{name: name, seed_count: count, seed_sender: sender}]
    end

    defp normalise_channel_spec(_), do: []

    defp coerce_count(n) when is_integer(n) and n >= 0, do: n
    defp coerce_count(_), do: 0

    defp coerce_sender(s) when is_binary(s) and byte_size(s) > 0, do: s
    defp coerce_sender(_), do: "seed-bot"
  end
end
