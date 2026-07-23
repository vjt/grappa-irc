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

  # Explicit string->atom map, NOT `~w(...)a` + `String.to_existing_atom/1`.
  # Found live 2026-07-23 (native Linux, MIX_ENV=prod mix task
  # invocation): `~w(...)a` only exists as atoms during THIS module's
  # own compile-time attribute evaluation — since the runtime function
  # body below only ever touches the derived STRINGS, the atoms
  # themselves never get compiled into this module's bytecode, so
  # loading `OptionParsing` does not register them in the atom table.
  # `to_existing_atom("nickserv_identify")` then raises unless some
  # OTHER module that references that literal atom (e.g. the
  # NetworkCredential schema's changeset validation) happened to load
  # first — true under a full release boot (everything gets referenced
  # eventually) but not guaranteed for a bare `mix grappa.bind_network`
  # invocation. Writing the atoms as literal map values here makes them
  # part of THIS module's own compiled bytecode, so they exist the
  # moment `OptionParsing` itself loads — no dependency on load order
  # elsewhere.
  @auth_map %{
    "auto" => :auto,
    "sasl" => :sasl,
    "server_pass" => :server_pass,
    "nickserv_identify" => :nickserv_identify,
    "none" => :none
  }
  @auth_strings Map.keys(@auth_map)

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
    case Map.fetch(@auth_map, str) do
      {:ok, atom} -> atom
      :error -> Mix.raise("--auth must be one of #{Enum.join(@auth_strings, "|")} (got #{inspect(str)})")
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
