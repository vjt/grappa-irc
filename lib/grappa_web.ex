defmodule GrappaWeb do
  @moduledoc """
  The web boundary — controllers, channels, router glue.

  `use GrappaWeb, :controller` and friends inject the right imports per
  module kind. Keep this module thin: it should never grow domain logic
  or compile-time wiring beyond `Phoenix.Controller` / `Phoenix.Router`
  / `Phoenix.Channel` plumbing.
  """

  use Boundary,
    top_level?: true,
    deps:
      [
        Grappa.AccountDeletion,
        Grappa.Accounts,
        Grappa.Admission,
        Grappa.AdminEvents,
        Grappa.Auth.IdentifierClassifier,
        Grappa.ChannelDirectory,
        Grappa.Cic.Bundle,
        Grappa.Cic.Wire,
        Grappa.ClientId,
        Grappa.DbLatency,
        Grappa.Health,
        Grappa.HotReload,
        Grappa.IRC,
        Grappa.LiveIntrospection,
        Grappa.Net.HostAddresses,
        Grappa.Net.IpLiteral,
        Grappa.Net.PtrCache,
        Grappa.Net.SourceAliasManager,
        Grappa.Networks,
        Grappa.Notify,
        Grappa.Operator,
        Grappa.OutboundV6Pool,
        # #505 — the web edge now reaches the presence decision only through
        # the resolver (pref + live member count + the rule); the pure rule
        # module `Grappa.PresenceFilter` sits behind it and is no longer
        # called from here.
        Grappa.PresenceFilter.Resolver,
        Grappa.Protocol,
        Grappa.PubSub,
        Grappa.Push,
        Grappa.Push.BadgeCount,
        Grappa.RateLimit,
        Grappa.QueryWindows,
        Grappa.ReadCursor,
        Grappa.Scrollback,
        Grappa.ServerSettings,
        Grappa.ServerSettings.Wire,
        Grappa.Session,
        Grappa.SessionLog,
        Grappa.SpawnOrchestrator,
        Grappa.Subject,
        Grappa.SubjectSearch,
        Grappa.Themes,
        Grappa.Uploads,
        Grappa.UserSettings,
        Grappa.Version,
        Grappa.Vhosts,
        Grappa.Visitors,
        Grappa.Visitors.ShareTokens,
        Grappa.Visitors.Visitor,
        Grappa.WindowCounts,
        Grappa.WSPresence,
        GrappaWeb.BodyLimit
      ] ++
        if(Mix.env() in [:dev, :test], do: [Grappa.TestSupport.SubjectReset], else: []),
    # `PasskeyOrigin` joins `Endpoint` on the export list for the same
    # reason: `Grappa.Application.start/2` reaches in to boot it, the
    # documented boot-time-config boundary. Nothing else outside
    # `GrappaWeb` may call it.
    exports: [Endpoint, PasskeyOrigin]

  @doc "Imports for `use GrappaWeb, :controller` — Phoenix.Controller + Plug.Conn + the JSON fallback."
  @spec controller() :: Macro.t()
  def controller do
    quote do
      use Phoenix.Controller, formats: [:json]
      import Plug.Conn

      action_fallback GrappaWeb.FallbackController
    end
  end

  @doc "Imports for `use GrappaWeb, :router` — Phoenix.Router with helpers off."
  @spec router() :: Macro.t()
  def router do
    quote do
      use Phoenix.Router, helpers: false

      import Plug.Conn
      import Phoenix.Controller
    end
  end

  @doc "Imports for `use GrappaWeb, :channel` — Phoenix.Channel only (no Endpoint coupling)."
  @spec channel() :: Macro.t()
  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
