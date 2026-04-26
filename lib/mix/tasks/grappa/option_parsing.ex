defmodule Mix.Tasks.Grappa.OptionParsing do
  @moduledoc """
  Shared CLI helpers for the `grappa.*` mix tasks.

  Lives under `Mix.Tasks` so it stays out of the runtime boundary
  graph — no production code depends on it; only the operator-side
  CLI tasks pull it in.

  These helpers raise `Mix.Error` on malformed input rather than
  returning error tuples: an operator typing `--server no-port` at
  the shell wants a loud, immediate failure with a clear message,
  not a `{:error, _}` ladder up to System.halt.
  """
  use Boundary, top_level?: true

  @auth_methods ~w(auto sasl server_pass nickserv_identify none)a
  @auth_strings Enum.map(@auth_methods, &Atom.to_string/1)

  @doc """
  Parses a `host:port` server spec into `{host, port}`. Raises on
  malformed input.
  """
  @spec parse_server(String.t()) :: {String.t(), :inet.port_number()}
  def parse_server(spec) when is_binary(spec) do
    case String.split(spec, ":") do
      [host, port_str] ->
        case Integer.parse(port_str) do
          {port, ""} when port > 0 and port <= 65_535 ->
            {host, port}

          _ ->
            Mix.raise("--server port must be 1..65535 (got #{inspect(port_str)})")
        end

      _ ->
        Mix.raise("--server must be host:port (got #{inspect(spec)})")
    end
  end

  @doc """
  Parses an `--auth` flag value into an atom. Raises on unknown values.
  """
  @spec parse_auth(String.t()) ::
          :auto | :sasl | :server_pass | :nickserv_identify | :none
  def parse_auth(str) when is_binary(str) do
    if str in @auth_strings do
      String.to_existing_atom(str)
    else
      Mix.raise("--auth must be one of #{Enum.join(@auth_strings, "|")} (got #{inspect(str)})")
    end
  end

  @doc """
  Parses a comma-separated channel list into `[String.t()]`. `nil`
  and the empty string both yield `[]`.
  """
  @spec parse_autojoin(String.t() | nil) :: [String.t()]
  def parse_autojoin(nil), do: []
  def parse_autojoin(""), do: []

  def parse_autojoin(str) when is_binary(str) do
    str
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
  end
end
