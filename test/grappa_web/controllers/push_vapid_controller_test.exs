defmodule GrappaWeb.PushVapidControllerTest do
  @moduledoc """
  REST surface for `Grappa.Push.Sender`'s VAPID public-key publish —
  push notifications cluster B2 (2026-05-14).

  Coverage:
    * GET /push/vapid-public-key returns the boot-pinned key (200).
    * No authentication required — cic SW fetches before user-session
      login.
    * Response shape is `%{public_key: String.t()}` — pinned because
      the cic helper (`getVapidPublicKey/0`) reads the `public_key`
      key by name.
    * H16 (REV-D): controller reads from `:persistent_term` via
      `Grappa.Push.vapid_public_key/0`, NOT runtime
      `Application.fetch_env!/2`. Removing the env value AFTER boot
      must not break the controller (the boot-time pin is the only
      source of truth post-`Grappa.Push.boot/0`).
  """
  use GrappaWeb.ConnCase, async: false

  alias Grappa.Push

  describe "GET /push/vapid-public-key" do
    test "returns the boot-pinned public key with no auth required", %{conn: conn} do
      pinned = Push.vapid_public_key()

      conn = get(conn, "/push/vapid-public-key")

      assert %{"public_key" => ^pinned} = json_response(conn, 200)
    end

    test "controller reads from :persistent_term not Application env (H16, REV-D)",
         %{conn: conn} do
      # Force a divergence: stash a sentinel via Push.boot, then mutate
      # the application env to a different value. The controller must
      # return the sentinel (persistent_term-pinned), proving the read
      # is NOT going through Application.fetch_env!/2 anymore.
      original = Push.vapid_public_key()
      sentinel = "sentinel-#{System.unique_integer([:positive])}"

      try do
        Application.put_env(:web_push_elixir, :vapid_public_key, sentinel)
        :ok = Push.boot()

        # Now flip the env to something else; the persistent_term value
        # remains the sentinel because boot has already pinned it.
        Application.put_env(:web_push_elixir, :vapid_public_key, "different-value")

        conn = get(conn, "/push/vapid-public-key")

        assert %{"public_key" => ^sentinel} = json_response(conn, 200),
               "Controller must read from :persistent_term (boot-pinned), " <>
                 "not runtime Application.fetch_env!/2 (H16 regression)."
      after
        # Restore original env + pin so siblings see the production value.
        Application.put_env(:web_push_elixir, :vapid_public_key, original)
        :ok = Push.boot()
      end
    end
  end
end
