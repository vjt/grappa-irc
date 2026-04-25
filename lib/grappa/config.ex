defmodule Grappa.Config do
  @moduledoc """
  Loads and validates the operator-edited TOML config file.

  Phase 1 shape: one server stanza + N users + N networks per user.
  Phase 2 will replace this with dynamic per-user database state.
  """

  alias Grappa.IRC.Identifier

  defmodule Server do
    @moduledoc "Bouncer's own HTTP listen address (e.g. `127.0.0.1:4000`)."
    @enforce_keys [:listen]
    defstruct [:listen]

    @type t :: %__MODULE__{listen: String.t()}
  end

  defmodule Network do
    @moduledoc """
    One upstream IRC network configured for a user.

    `sasl_password` and `autojoin` are optional; everything else is
    required. SASL credentials live in the operator-edited TOML for
    Phase 1 — Phase 2 moves them to the encrypted DB.
    """
    @enforce_keys [:id, :host, :port, :tls, :nick]
    defstruct [:id, :host, :port, :tls, :nick, sasl_password: nil, autojoin: []]

    @type t :: %__MODULE__{
            id: String.t(),
            host: String.t(),
            port: 1..65_535,
            tls: boolean(),
            nick: String.t(),
            sasl_password: String.t() | nil,
            autojoin: [String.t()]
          }
  end

  defmodule User do
    @moduledoc "A bouncer user with one or more upstream networks."
    @enforce_keys [:name, :networks]
    defstruct [:name, :networks]

    @type t :: %__MODULE__{name: String.t(), networks: [Network.t()]}
  end

  @enforce_keys [:server, :users]
  defstruct [:server, :users]

  @type t :: %__MODULE__{server: Server.t(), users: [User.t()]}

  @type load_error ::
          {:file_not_found, Path.t()}
          | {:io_error, File.posix(), Path.t()}
          | {:invalid_toml, String.t()}
          | {:invalid_config, String.t()}

  @doc """
  Reads a TOML file from disk and validates its shape. Convenience
  wrapper over `File.read/1` + `Toml.decode/1` + `validate/1`.

  Returns `{:ok, config}` on success or a tagged error tuple
  (`load_error/0`) so callers can distinguish missing-file from
  parse-error from validation-error and react accordingly.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, load_error()}
  def load(path) do
    with {:ok, raw} <- read_file(path),
         {:ok, parsed} <- decode_toml(raw) do
      validate(parsed)
    end
  end

  @doc """
  Validates an already-parsed TOML map (e.g. from a non-file source —
  Phase 2 REST endpoint, programmatic test fixtures). Returns the
  same `load_error/0` variants for missing or malformed fields.
  """
  @spec validate(map()) :: {:ok, t()} | {:error, load_error()}
  def validate(parsed) when is_map(parsed) do
    with {:ok, server} <- build_server(parsed),
         {:ok, users} <- build_users(parsed) do
      {:ok, %__MODULE__{server: server, users: users}}
    end
  end

  @doc """
  Renders a `load_error/0` tuple to a single human-readable line for
  log output.
  """
  @spec format_error(load_error()) :: String.t()
  def format_error({:file_not_found, path}), do: "config file not found: #{path}"
  def format_error({:io_error, reason, path}), do: "cannot read #{path}: #{reason}"
  def format_error({:invalid_toml, msg}), do: "invalid toml: #{msg}"
  def format_error({:invalid_config, msg}), do: "invalid config: #{msg}"

  defp read_file(path) do
    case File.read(path) do
      {:ok, raw} -> {:ok, raw}
      {:error, :enoent} -> {:error, {:file_not_found, path}}
      {:error, reason} -> {:error, {:io_error, reason, path}}
    end
  end

  defp decode_toml(raw) do
    case Toml.decode(raw) do
      {:ok, map} -> {:ok, map}
      {:error, {:invalid_toml, msg}} -> {:error, {:invalid_toml, msg}}
      {:error, msg} when is_binary(msg) -> {:error, {:invalid_toml, msg}}
    end
  end

  defp build_server(%{"server" => %{"listen" => listen}}) when is_binary(listen),
    do: {:ok, %Server{listen: listen}}

  defp build_server(_), do: invalid_config("[server] table missing required field: listen")

  defp build_users(%{"users" => [_ | _] = list}), do: traverse(list, &build_user/1)
  defp build_users(_), do: invalid_config("no [[users]] entries found")

  defp build_user(%{"name" => name} = raw) when is_binary(name) do
    networks_raw = Map.get(raw, "networks", [])

    with {:ok, networks} <- build_networks(networks_raw) do
      {:ok, %User{name: name, networks: networks}}
    end
  end

  defp build_user(_), do: invalid_config("[[users]] entry missing required field: name")

  defp build_networks(list) when is_list(list), do: traverse(list, &build_network/1)

  # Maps `fun` across `list`, collecting successful results.
  # Returns the first `{:error, _}` encountered without visiting the rest.
  @spec traverse([raw], (raw -> {:ok, item} | {:error, load_error()})) ::
          {:ok, [item]} | {:error, load_error()}
        when raw: term(), item: term()
  defp traverse(list, fun), do: traverse(list, [], fun)

  defp traverse([], acc, _), do: {:ok, Enum.reverse(acc)}

  defp traverse([head | tail], acc, fun) do
    case fun.(head) do
      {:ok, item} -> traverse(tail, [item | acc], fun)
      {:error, _} = err -> err
    end
  end

  defp build_network(%{"id" => id, "host" => host, "port" => port, "tls" => tls, "nick" => nick} = raw)
       when is_binary(id) and is_binary(host) and is_integer(port) and is_boolean(tls) and
              is_binary(nick) do
    autojoin = Map.get(raw, "autojoin", [])

    with :ok <- validate_network_fields(id, host, nick, autojoin) do
      {:ok,
       %Network{
         id: id,
         host: host,
         port: port,
         tls: tls,
         nick: nick,
         sasl_password: Map.get(raw, "sasl_password"),
         autojoin: autojoin
       }}
    end
  end

  defp build_network(raw) do
    missing =
      ~w[id host port tls nick]
      |> Enum.reject(&Map.has_key?(raw, &1))
      |> Enum.join(", ")

    invalid_config("[[users.networks]] entry missing required field(s): #{missing}")
  end

  defp validate_network_fields(id, host, nick, autojoin) do
    cond do
      not Identifier.valid_network_id?(id) ->
        invalid_config(
          "[[users.networks]] invalid id #{inspect(id)} (lowercase alphanumeric + dash + underscore, 1-32 chars)"
        )

      not Identifier.valid_host?(host) ->
        invalid_config("[[users.networks]] invalid host #{inspect(host)} (non-empty, no whitespace or control chars)")

      not Identifier.valid_nick?(nick) ->
        invalid_config("[[users.networks]] invalid nick #{inspect(nick)} (RFC 2812 nick syntax)")

      true ->
        validate_autojoin(autojoin)
    end
  end

  defp validate_autojoin(list) when is_list(list) do
    case Enum.find(list, fn ch -> not Identifier.valid_channel?(ch) end) do
      nil ->
        :ok

      bad ->
        invalid_config("[[users.networks]] invalid autojoin channel #{inspect(bad)} (must start with #/&/+/!)")
    end
  end

  defp validate_autojoin(_), do: invalid_config("[[users.networks]] autojoin must be a list")

  defp invalid_config(msg), do: {:error, {:invalid_config, msg}}
end
