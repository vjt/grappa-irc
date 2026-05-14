defmodule GrappaWeb.PushVapidControllerTest do
  @moduledoc """
  REST surface for `Grappa.Push.Sender`'s VAPID public-key publish —
  push notifications cluster B2 (2026-05-14).

  Coverage:
    * GET /push/vapid-public-key returns the configured key (200).
    * No authentication required — cic SW fetches before user-session
      login.
    * Response shape is `%{public_key: String.t()}` — pinned because
      the cic helper (`getVapidPublicKey/0`) reads the `public_key`
      key by name.
  """
  use GrappaWeb.ConnCase, async: true

  describe "GET /push/vapid-public-key" do
    test "returns the configured public key with no auth required", %{conn: conn} do
      configured = Application.fetch_env!(:web_push_elixir, :vapid_public_key)

      conn = get(conn, "/push/vapid-public-key")

      assert %{"public_key" => ^configured} = json_response(conn, 200)
    end
  end
end
