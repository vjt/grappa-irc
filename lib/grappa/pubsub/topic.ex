defmodule Grappa.PubSub.Topic do
  @moduledoc """
  Single source of truth for `Grappa.PubSub` topic shapes.

  Topic shapes (from CLAUDE.md, `grappa:` prefix mandatory):

    * `grappa:user:{user_name}` — per-user fan-out
    * `grappa:network:{network_id}` — network-level fan-out
    * `grappa:network:{network_id}/channel:{channel_name}` — per-channel
      fan-out (the only shape Phase 1 actively broadcasts on)

  Topic-shape evolution must go through this module: every broadcaster,
  every subscriber-side validator, and every router-side wildcard share
  the same vocabulary. Phase 6 IRCv3 listener must subscribe on the same
  topics — no state bifurcation per `docs/DESIGN_NOTES.md`.

  Identifiers are passed through verbatim. Identifier syntax validation
  lives in `Grappa.IRC.Identifier` (Phase 1.5) and is enforced at the
  producing boundary (Config network builder + Scrollback Message
  changeset) rather than re-checked here.
  """

  @type t :: String.t()
  @type parsed ::
          {:user, String.t()}
          | {:network, String.t()}
          | {:channel, String.t(), String.t()}

  @doc "Builds the per-user fan-out topic."
  @spec user(String.t()) :: t()
  def user(user_name) when is_binary(user_name) and user_name != "" do
    "grappa:user:" <> user_name
  end

  @doc "Builds the network-level fan-out topic."
  @spec network(String.t()) :: t()
  def network(network_id) when is_binary(network_id) and network_id != "" do
    "grappa:network:" <> network_id
  end

  @doc "Builds the per-channel fan-out topic (the only shape Phase 1 actively broadcasts on)."
  @spec channel(String.t(), String.t()) :: t()
  def channel(network_id, channel_name)
      when is_binary(network_id) and network_id != "" and
             is_binary(channel_name) and channel_name != "" do
    "grappa:network:" <> network_id <> "/channel:" <> channel_name
  end

  @doc """
  Decodes a topic string back into its tagged-tuple form.

  Returns `{:ok, parsed}` for any of the three documented shapes,
  `:error` for anything else (empty identifiers included).
  """
  @spec parse(String.t()) :: {:ok, parsed()} | :error
  def parse("grappa:user:" <> rest) when rest != "" do
    {:ok, {:user, rest}}
  end

  def parse("grappa:network:" <> rest) when rest != "" do
    case String.split(rest, "/", parts: 2) do
      [net] when net != "" ->
        {:ok, {:network, net}}

      [net, "channel:" <> chan] when net != "" and chan != "" ->
        {:ok, {:channel, net, chan}}

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
end
