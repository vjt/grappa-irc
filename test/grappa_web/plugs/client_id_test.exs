defmodule GrappaWeb.Plugs.ClientIdTest do
  @moduledoc """
  Direct exercise of the `ClientId` plug. Single source of truth for
  `X-Grappa-Client-Id` extraction + validation; the previously duplicated
  describe block in `GrappaWeb.Plugs.AuthnTest` (and the inline copy in
  `AuthController`) was retired in favour of this one spot.

  Decision E (cluster/t31-cleanup) tightened the wire shape from
  "URL-safe ASCII up to 64 bytes" to UUID v4 canonical form, sharing
  the regex with `Grappa.ClientId`. Fixtures here are UUID v4 values.
  """
  use ExUnit.Case, async: true

  import Plug.Conn, only: [put_req_header: 3]
  import Plug.Test

  alias GrappaWeb.Plugs.ClientId

  # Two distinct UUID v4 fixtures — keep them named so failures point at
  # the same literal across the file. Do NOT use `Ecto.UUID.generate/0`:
  # spec calls for explicit fixtures so failures are reproducible.
  @valid_v4 "44c2ab8a-cb38-4960-b92a-a7aefb190386"

  defp call_plug(conn), do: ClientId.call(conn, ClientId.init([]))

  describe "X-Grappa-Client-Id extraction" do
    test "valid UUID v4 header → assign set to header value" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", @valid_v4)
        |> call_plug()

      assert conn.assigns.current_client_id == @valid_v4
    end

    test "valid UUID v4 header (uppercase hex) → assign set" do
      val = String.upcase(@valid_v4)

      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", val)
        |> call_plug()

      assert conn.assigns.current_client_id == val
    end

    test "missing header → assign is nil" do
      conn = :get |> conn("/") |> call_plug()
      assert conn.assigns.current_client_id == nil
    end

    test "header oversized (UUID-shaped prefix + extra bytes) → assign is nil" do
      # Anchored regex: trailing junk after a valid UUID still rejects.
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", @valid_v4 <> "-extra")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "header > 64 bytes (legacy oversize boundary) → assign is nil" do
      # Holdover from the old 64-byte cap: anchored UUID v4 regex makes
      # the byte-size guard redundant, but keep the assertion to demonstrate
      # the new contract still rejects long input.
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", String.duplicate("x", 65))
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "header with `/` → assign is nil" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "bad/value")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "header with `;` → assign is nil" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "bad;value")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "non-v4 UUID (version nibble = 1) → assign is nil" do
      # The previous lax regex accepted anything URL-safe — the new
      # ClientId type asserts the v4 nibble. Document the tightening.
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "44c2ab8a-cb38-1960-b92a-a7aefb190386")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "UUID without hyphens (raw 32 hex) → assign is nil" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "44c2ab8acb384960b92aa7aefb190386")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "empty header value → assign is nil" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "never halts the conn" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "garbage with spaces")
        |> call_plug()

      refute conn.halted
    end
  end
end
