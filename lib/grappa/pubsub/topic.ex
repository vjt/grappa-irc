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
    * `grappa:admin:events` — admin-events fan-out (M-cluster M-11).
      Authz is `is_admin: true` gated at `GrappaWeb.AdminChannel`, NOT
      per-user. Single topic for the whole admin operator console.
      Lives outside the user-rooted shape because the audience is
      admin operators, not the per-user subject; folding onto
      `grappa:user:*` would force a phantom user_name segment whose
      authz check would never match.
    * `grappa:ws_presence:{user_name}` — server-internal bridge from
      the WS edge (`Grappa.WSPresence`) to per-`(user, network)`
      `Grappa.Session.Server` processes for auto-away timing. Distinct
      direction (edge → session) and audience (per-session subscribers,
      not browser clients) — never exposed via `parse/1` or `valid?/1`
      so an external `Channel.join/3` cannot subscribe to it.

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
          | :admin_events

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

  @doc """
  Builds the per-(user, network, channel) fan-out topic.

  UX-4 bucket A: the `channel_name` segment is canonicalised to
  lowercase via `Grappa.IRC.Identifier.canonical_channel/1` (sigil-
  aware — nicks for DM windows pass through unchanged). Every
  broadcaster, every subscriber-side `Channel.join/3` callback, and
  every `parse/1` callsite observe the same topic string regardless
  of whether the producer received the channel name from upstream
  IRC (case-as-sent), from the operator (case-as-typed), or from a
  REST controller (case-as-URL-segment). Before bucket A, the
  segment was passed through verbatim — `#Chan` and `#chan`
  produced two distinct PubSub topics, partitioning subscribers and
  silently dropping fan-out for one of the cases.
  """
  @spec channel(String.t(), String.t(), String.t()) :: t()
  def channel(user_name, network_slug, channel_name)
      when is_binary(user_name) and user_name != "" and
             is_binary(network_slug) and network_slug != "" and
             is_binary(channel_name) and channel_name != "" do
    "grappa:user:" <>
      user_name <>
      "/network:" <>
      network_slug <>
      "/channel:" <> Grappa.IRC.Identifier.canonical_channel(channel_name)
  end

  @doc """
  Builds the admin-events fan-out topic (M-cluster M-11).

  Single fixed topic — admin operator console consumes one
  unified event stream. Authz is `is_admin: true` gated at
  `GrappaWeb.AdminChannel`'s join callback (NOT at the per-user
  shape the other topics use); the topic itself carries no
  user identifier.
  """
  @spec admin_events() :: t()
  def admin_events, do: "grappa:admin:events"

  @doc """
  Builds the WSPresence bridge topic.

  Internal grappa-side fan-out from the WS edge (`Grappa.WSPresence`)
  to per-`(user, network)` `Grappa.Session.Server` processes for the
  auto-away debounce. Distinct from `user/1`: direction (edge →
  session), audience (per-session subscribers, NOT browser
  subscribers), and lifecycle (subscribed at session boot, dropped on
  session crash) all differ from the per-user broadcast surface.
  Folding onto `user/1` would couple the two fan-out shapes and let
  ws_presence noise reach Channel subscribers.

  Excluded from `parse/1` and `valid?/1` on purpose: those validate
  the public topic grammar enforced at `GrappaWeb.GrappaChannel`'s
  `join/3` callback. This bridge topic must never be subscribable by
  an external WS client.
  """
  @spec ws_presence(String.t()) :: t()
  def ws_presence(user_name) when is_binary(user_name) and user_name != "" do
    "grappa:ws_presence:" <> user_name
  end

  @doc """
  Decodes a topic string back into its tagged-tuple form.

  Returns `{:ok, parsed}` for any of the three documented shapes,
  `:error` for anything else (empty identifiers, missing segments,
  Phase 1 `grappa:network:...` shape, unknown prefix).
  """
  @spec parse(String.t()) :: {:ok, parsed()} | :error
  def parse("grappa:admin:events"), do: {:ok, :admin_events}

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
  Returns the user_name embedded in any of the three user-rooted topic
  shapes. Used by `GrappaWeb.GrappaChannel` on join for the cross-user
  authz check — every user-rooted topic carries the user, so a single
  predicate covers `:user | :network | :channel`.

  Does NOT accept `:admin_events` (M-cluster M-11): admin topic carries
  no user identifier and the FunctionClauseError on a stray call is the
  intended fail-loud signal. Admin authz lives at
  `GrappaWeb.AdminChannel`'s `join/3` callback (is_admin gate), never
  reaches `user_of/1`.
  """
  @spec user_of(parsed()) :: String.t()
  def user_of({:user, name}), do: name
  def user_of({:network, name, _}), do: name
  def user_of({:channel, name, _, _}), do: name
end
