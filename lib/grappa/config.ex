defmodule Grappa.Config do
  @moduledoc """
  Loads and validates the operator-edited TOML config file.

  Phase 1 shape: one server stanza + N users + N networks per user.
  Phase 2 will replace this with dynamic per-user database state.
  """

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

  @doc """
  Loads and validates a TOML config file.

  Returns `{:ok, config}` on success or `{:error, message}` on parse / validation failure.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, String.t()}
  def load(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, parsed} <- Toml.decode(raw),
         {:ok, server} <- build_server(parsed),
         {:ok, users} <- build_users(parsed) do
      {:ok, %__MODULE__{server: server, users: users}}
    else
      {:error, reason} when is_atom(reason) -> {:error, "cannot read #{path}: #{reason}"}
      {:error, {:invalid_toml, reason}} -> {:error, "invalid toml: #{reason}"}
      {:error, msg} when is_binary(msg) -> {:error, msg}
    end
  end

  defp build_server(%{"server" => %{"listen" => listen}}) when is_binary(listen),
    do: {:ok, %Server{listen: listen}}

  defp build_server(_), do: {:error, "[server] table missing required field: listen"}

  defp build_users(%{"users" => [_ | _] = list}), do: traverse(list, &build_user/1)
  defp build_users(_), do: {:error, "no [[users]] entries found"}

  defp build_user(%{"name" => name} = raw) when is_binary(name) do
    networks_raw = Map.get(raw, "networks", [])

    with {:ok, networks} <- build_networks(networks_raw) do
      {:ok, %User{name: name, networks: networks}}
    end
  end

  defp build_user(_), do: {:error, "[[users]] entry missing required field: name"}

  defp build_networks(list) when is_list(list), do: traverse(list, &build_network/1)

  # Maps `fun` across `list`, collecting successful results.
  # Returns the first `{:error, _}` encountered without visiting the rest.
  @spec traverse([raw], (raw -> {:ok, item} | {:error, String.t()})) ::
          {:ok, [item]} | {:error, String.t()}
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
    {:ok,
     %Network{
       id: id,
       host: host,
       port: port,
       tls: tls,
       nick: nick,
       sasl_password: Map.get(raw, "sasl_password"),
       autojoin: Map.get(raw, "autojoin", [])
     }}
  end

  defp build_network(raw) do
    missing =
      ~w[id host port tls nick]
      |> Enum.reject(&Map.has_key?(raw, &1))
      |> Enum.join(", ")

    {:error, "[[users.networks]] entry missing required field(s): #{missing}"}
  end
end
