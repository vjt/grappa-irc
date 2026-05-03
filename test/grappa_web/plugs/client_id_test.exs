defmodule GrappaWeb.Plugs.ClientIdTest do
  @moduledoc """
  Direct exercise of the `ClientId` plug. Single source of truth for
  `X-Grappa-Client-Id` extraction + validation; the previously duplicated
  describe block in `GrappaWeb.Plugs.AuthnTest` (and the inline copy in
  `AuthController`) was retired in favour of this one spot.
  """
  use ExUnit.Case, async: true

  import Plug.Conn, only: [put_req_header: 3]
  import Plug.Test

  alias GrappaWeb.Plugs.ClientId

  defp call_plug(conn), do: ClientId.call(conn, ClientId.init([]))

  describe "X-Grappa-Client-Id extraction" do
    test "valid header → assign set to header value" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "device-uuid-1")
        |> call_plug()

      assert conn.assigns.current_client_id == "device-uuid-1"
    end

    test "missing header → assign is nil" do
      conn = :get |> conn("/") |> call_plug()
      assert conn.assigns.current_client_id == nil
    end

    test "header > 64 bytes → assign is nil" do
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

    test "empty header value → assign is nil" do
      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", "")
        |> call_plug()

      assert conn.assigns.current_client_id == nil
    end

    test "valid header at exactly 64 bytes → assign set (boundary)" do
      val = String.duplicate("a", 64)

      conn =
        :get
        |> conn("/")
        |> put_req_header("x-grappa-client-id", val)
        |> call_plug()

      assert conn.assigns.current_client_id == val
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
