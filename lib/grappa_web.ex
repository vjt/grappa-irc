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
        Grappa.Accounts.Session,
        Grappa.Accounts.User,
        Grappa.Accounts.Revocations,
        Grappa.Admission,
        Grappa.AdminEvents,
        Grappa.AdminOverview,
        Grappa.Auth.IdentifierClassifier,
        # M3b — `NetworksController.peer_avatar/2` serves a cached peer
        # avatar; `Grappa.Uploads.MimeExt`-shaped serving lives on
        # `Grappa.Avatars` directly (a separate trust domain from
        # `Grappa.Uploads` — see that module's moduledoc).
        Grappa.Avatars,
        Grappa.ChannelDirectory,
        Grappa.Cic.Bundle,
        Grappa.Cic.Wire,
        Grappa.ClientId,
        Grappa.DbLatency,
        # issue 2089 — `DccFilesController.show/2` serves an accepted DCC
        # file'"'"'s bytes. Same posture as the peer-avatar dep above: a
        # stranger'"'"'s bytes are a separate trust domain from `Grappa.Uploads`,
        # so they get their own context and their own authenticated route.
        Grappa.Dcc,
        Grappa.Health,
        Grappa.HotReload,
        Grappa.IRC,
        Grappa.LiveIntrospection,
        Grappa.Net.HostAddresses,
        Grappa.Net.IpLiteral,
        Grappa.Net.PtrCache,
        Grappa.Net.SourceAliasManager,
        Grappa.Networks,
        Grappa.Networks.Credential,
        Grappa.Networks.Network,
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
        Grappa.ShareTokens,
        Grappa.SpawnOrchestrator,
        Grappa.Subject,
        Grappa.SubjectSearch,
        Grappa.Themes,
        Grappa.Uploads,
        Grappa.UserSettings,
        Grappa.Version,
        Grappa.Vhosts,
        Grappa.Visitors,
        # #1770 — the channel arms the incognito fast close on `client_closing`.
        # The Reaper is its own `top_level?: true` boundary, so this declares
        # the leaf that owns the verb rather than widening `Grappa.Visitors`.
        Grappa.Visitors.Reaper,
        Grappa.Visitors.Visitor,
        Grappa.WindowCounts,
        Grappa.WSPresence,
        GrappaWeb.BodyLimit
      ] ++
        if(Mix.env() in [:dev, :test],
          do: [Grappa.TestSupport.SubjectProvision, Grappa.TestSupport.SubjectReset],
          else: []
        ),
    # `PasskeyOrigin` joins `Endpoint` on the export list for the same
    # reason: `Grappa.Application.start/2` reaches in to boot it, the
    # documented boot-time-config boundary. Nothing else outside
    # `GrappaWeb` may call it. `SessionRevocationListener` is on the list
    # for the same and only that reason — it is a supervised child of the
    # application tree; no caller outside `GrappaWeb` invokes it.
    exports: [Endpoint, PasskeyOrigin, SessionRevocationListener]

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
