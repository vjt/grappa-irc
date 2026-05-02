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
    deps: [
      Grappa.Accounts,
      Grappa.Auth.IdentifierClassifier,
      Grappa.IRC,
      Grappa.Networks,
      Grappa.PubSub,
      Grappa.Scrollback,
      Grappa.Session,
      Grappa.Visitors
    ],
    exports: [Endpoint]

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
