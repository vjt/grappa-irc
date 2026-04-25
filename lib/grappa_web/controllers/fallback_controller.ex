defmodule GrappaWeb.FallbackController do
  @moduledoc """
  `action_fallback` target. Centralises the `{:error, term}` → HTTP
  response mapping so each action can return idiomatic tagged tuples
  instead of touching `conn` on the unhappy path.
  """
  use GrappaWeb, :controller

  @spec call(Plug.Conn.t(), {:error, :not_found | Ecto.Changeset.t()}) :: Plug.Conn.t()
  def call(conn, {:error, :not_found}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not found"})
  end

  def call(conn, {:error, %Ecto.Changeset{} = changeset}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{errors: traverse(changeset)})
  end

  defp traverse(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {k, v}, acc ->
        String.replace(acc, "%{#{k}}", to_string(v))
      end)
    end)
  end
end
