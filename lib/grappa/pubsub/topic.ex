defmodule Grappa.PubSub.Topic do
  @moduledoc """
  Single source of truth for `Grappa.PubSub` topic shapes.

  Phase 2 sub-task 2h roots every topic in the user discriminator —
  `Phoenix.PubSub` topic strings live in a global namespace, so a
  per-channel topic without the user_name would let any subscriber
  read events from any other user's session. The wire payload already
  drops `user_id` (decision G3) but DELIVERY routing leaks until the
  topic string itself partitions per user.

  Topic shapes (`grappa:` prefix mandatory per CLAUDE.md):

    * `grappa:user:{user_name}` — per-user fan-out
    * `grappa:user:{user_name}/network:{network_slug}` — per-(user,
      network) fan-out
    * `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`
      — per-(user, network, channel) fan-out (the only shape currently
      broadcast on; network and user shapes are reserved for upcoming
      MOTD / NOTICE / connection-state events)

  Topic-shape evolution must go through this module: every broadcaster,
  every subscriber-side validator, and every router-side wildcard share
  the same vocabulary. Phase 6 IRCv3 listener must subscribe on the
  same topics — no state bifurcation per `docs/DESIGN_NOTES.md`.

  Identifiers are passed through verbatim. Identifier syntax validation
  lives in `Grappa.IRC.Identifier`, `Grappa.Accounts.User`, and
  `Grappa.Networks.Network` and is enforced at the producing boundary.
  """

  @type t :: String.t()
  @type parsed ::
          {:user, String.t()}
          | {:network, String.t(), String.t()}
          | {:channel, String.t(), String.t(), String.t()}

  @doc "Builds the per-user fan-out topic."
  @spec user(String.t()) :: t()
  def user(user_name) when is_binary(user_name) and user_name != "" do
    "grappa:user:" <> user_name
  end

  @doc "Builds the per-(user, network) fan-out topic."
  @spec network(String.t(), String.t()) :: t()
  def network(user_name, network_slug)
      when is_binary(user_name) and user_name != "" and
             is_binary(network_slug) and network_slug != "" do
    "grappa:user:" <> user_name <> "/network:" <> network_slug
  end

  @doc "Builds the per-(user, network, channel) fan-out topic."
  @spec channel(String.t(), String.t(), String.t()) :: t()
  def channel(user_name, network_slug, channel_name)
      when is_binary(user_name) and user_name != "" and
             is_binary(network_slug) and network_slug != "" and
             is_binary(channel_name) and channel_name != "" do
    "grappa:user:" <>
      user_name <>
      "/network:" <> network_slug <> "/channel:" <> channel_name
  end

  @doc """
  Decodes a topic string back into its tagged-tuple form.

  Returns `{:ok, parsed}` for any of the three documented shapes,
  `:error` for anything else (empty identifiers, missing segments,
  Phase 1 `grappa:network:...` shape, unknown prefix).
  """
  @spec parse(String.t()) :: {:ok, parsed()} | :error
  def parse("grappa:user:" <> rest) when rest != "" do
    case String.split(rest, "/", parts: 3) do
      [name] ->
        {:ok, {:user, name}}

      [name, "network:" <> slug] when name != "" and slug != "" ->
        {:ok, {:network, name, slug}}

      [name, "network:" <> slug, "channel:" <> chan]
      when name != "" and slug != "" and chan != "" ->
        {:ok, {:channel, name, slug, chan}}

      _ ->
        :error
    end
  end

  def parse(_), do: :error

  @doc "True iff the input matches one of the documented topic shapes."
  @spec valid?(String.t()) :: boolean()
  def valid?(topic) when is_binary(topic) do
    case parse(topic) do
      {:ok, _} -> true
      :error -> false
    end
  end

  @doc """
  Returns the user_name embedded in any of the three documented topic
  shapes. Used by `GrappaWeb.GrappaChannel` on join for the cross-user
  authz check — every Grappa topic is rooted in a user, so a single
  predicate covers all shapes.
  """
  @spec user_of(parsed()) :: String.t()
  def user_of({:user, name}), do: name
  def user_of({:network, name, _}), do: name
  def user_of({:channel, name, _, _}), do: name
end
