defmodule GrappaWeb.Plugs.ClientId do
  @moduledoc """
  Extracts and validates the `X-Grappa-Client-Id` request header into
  `conn.assigns.current_client_id`.

  ## Why the `:api` pipeline

  `:api` is the highest pipeline shared by `/auth/login` (unauthenticated
  — login mints the bearer token) AND every authenticated route via
  `:authn`. Wiring extraction here populates the assign exactly once per
  request, removing the duplicated regex + validation that previously
  lived inline in both `GrappaWeb.Plugs.Authn` (authenticated routes)
  AND `GrappaWeb.AuthController` (visitor login).

  ## Why nil-on-malformed (never halt)

  This plug does NOT halt on missing or malformed headers — it just
  assigns `nil`. Boundary tolerance: deciding what to do with a missing
  client_id is admission policy (the per-(client, network) cap may
  treat `nil` as "unknown — apply the strictest tier" or "ignore — fall
  back to per-IP heuristics"), not a header-shape concern. `cicchetto`
  generates a UUID v4 by spec; only an attacker submits garbage, and
  the cap-check downstream is the right layer to reject them.

  ## Wire shape

  UUID v4 canonical form (decision E, cluster/t31-cleanup). The regex
  is sourced from `Grappa.ClientId.regex/0` so the boundary check and
  the schema-side cast (`field :client_id, Grappa.ClientId`) share a
  single source of truth — drift is impossible. The fixed 36-char
  anchored regex makes byte-size guards redundant.
  """
  @behaviour Plug

  import Plug.Conn

  @client_id_regex Grappa.ClientId.regex()

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    assign(conn, :current_client_id, extract(conn))
  end

  @spec extract(Plug.Conn.t()) :: String.t() | nil
  defp extract(conn) do
    case get_req_header(conn, "x-grappa-client-id") do
      [value | _] when is_binary(value) ->
        if valid?(value), do: value, else: nil

      _ ->
        nil
    end
  end

  @spec valid?(String.t()) :: boolean()
  defp valid?(value), do: Regex.match?(@client_id_regex, value)
end
