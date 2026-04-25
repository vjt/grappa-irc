defmodule Grappa.Application do
  @moduledoc false

  use Boundary,
    top_level?: true,
    deps: [Grappa.Bootstrap, Grappa.PubSub, Grappa.Repo, Grappa.Vault, GrappaWeb]

  use Application

  @impl Application
  def start(_, _) do
    # Child order is load-bearing — see CLAUDE.md "Don't touch supervision
    # tree ordering casually." Each comment below documents the WHY so a
    # reorder is a deliberate choice.
    children =
      [
        # Vault before Repo: Cloak's Ecto types (Grappa.EncryptedBinary)
        # reach into the Vault GenServer at schema dump/load time. If
        # Repo loaded a schema with an encrypted field before Vault was
        # up, the type callback would crash with `:noproc`.
        Grappa.Vault,

        # Must come first (after Vault): every context that touches the
        # DB depends on Repo being up. Sessions write Scrollback rows;
        # Phase 2 schemas (network_credentials) carry encrypted columns
        # that need Vault — hence Vault first.
        Grappa.Repo,

        # PubSub before Endpoint — Endpoint's compile-time config names
        # `pubsub_server: Grappa.PubSub` and the channel layer subscribes
        # at join time. Sessions broadcast inbound PRIVMSGs over PubSub.
        {Phoenix.PubSub, name: Grappa.PubSub},

        # Registry before DynamicSupervisor — Session.Server registers
        # itself under {:session, user, network_id} via this Registry,
        # and lookups happen in DynamicSupervisor's start_child cascade.
        {Registry, keys: :unique, name: Grappa.SessionRegistry},
        {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one},

        # Endpoint after PubSub + Registry — HTTP requests (REST controller,
        # WS Channel join) reach into both at request time.
        GrappaWeb.Endpoint

        # Bootstrap is appended LAST below: it depends on Registry +
        # SessionSupervisor existing so it can spawn sessions. Conditional
        # on :start_bootstrap so test boots empty.
      ] ++ bootstrap_child()

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Bootstrap is opt-in via the `:start_bootstrap` flag (true in dev/prod,
  # false in test) so the test suite doesn't try to spawn live IRC sessions
  # against the operator's real grappa.toml when running `mix test`.
  @spec bootstrap_child() :: [] | [{Grappa.Bootstrap, [config_path: String.t()]}]
  defp bootstrap_child do
    if Application.get_env(:grappa, :start_bootstrap, true) do
      [{Grappa.Bootstrap, config_path: Application.fetch_env!(:grappa, :config_path)}]
    else
      []
    end
  end

  @impl Application
  def config_change(changed, _, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
