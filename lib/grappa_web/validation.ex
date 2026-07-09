defmodule GrappaWeb.Validation do
  @moduledoc """
  Boundary-shape validators shared by the JSON REST controllers.

  These check input *shape* (channel-name well-formedness, etc.) before
  the controller hands the value to a context. They surface as
  `{:error, :bad_request}` so the `FallbackController` returns 400 —
  distinct from the wire-injection guard inside
  `Grappa.IRC.Identifier.safe_line_token?/1` which surfaces as
  `:invalid_line` once the channel name reaches `Grappa.Session`.

  Live here (not in a per-controller `defp`) so both
  `MessagesController` and `ChannelsController` share one definition
  per CLAUDE.md "Implement once, reuse everywhere." Belongs to the
  `GrappaWeb` boundary (no explicit `use Boundary`) — controllers
  import it the same way they import other helpers.
  """

  alias Grappa.IRC.Identifier

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC channel name
  (`#`/`&`/`+`/`!` sigil + chanstring per RFC 2812 §1.3), else
  `{:error, :bad_request}`.
  """
  @spec validate_channel_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_channel_name(name) do
    if Identifier.valid_channel?(name), do: :ok, else: {:error, :bad_request}
  end

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC PRIVMSG read
  target — either a channel name (`#`/`&`/`+`/`!` sigil per RFC 2812
  §1.3), a nick (RFC 2812 §2.3.1), or the Grappa-internal synthetic
  `"$server"` pseudo-target used for the server-messages window.

  `"$server"` is not a real IRC target — it is a Grappa-internal name
  written by `Grappa.Session.Server` when persisting server NOTICEs,
  MOTD lines, and other messages without an explicit channel context.
  The synthetic must be accepted here so `loadInitialScrollback` REST
  fetch succeeds for the Server window in cicchetto.

  **Read-only** — used by `MessagesController.index/2` (GET) and
  `ChannelsController` for membership reads.
  `MessagesController.create/2` (POST) uses the stricter
  `validate_post_target_name/1` because RFC 2812 §3.3.1 server-mask
  syntax (`$mask`) is a real IRC target form: a write to `"$server"`
  would smuggle a `PRIVMSG $server :body` upstream and probe operator
  privileges. Read paths are safe — they only consult the local DB.
  """
  @spec validate_target_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_target_name("$server"), do: :ok

  def validate_target_name(name) do
    if Identifier.valid_channel?(name) or Identifier.valid_nick?(name),
      do: :ok,
      else: {:error, :bad_request}
  end

  @doc """
  Like `validate_target_name/1` but rejects the `"$server"` synthetic.

  Codebase review 2026-05-08 W1: PRIVMSG to `$server` is a server-mask
  write per RFC 2812 §3.3.1 — accepting it on POST lets a client smuggle
  bytes upstream, pollute the synthetic Server-window scrollback via the
  single-source echo path, and probe operator privileges. The synthetic
  is for *reading* server-window scrollback, never for *writing*.
  Used by `MessagesController.create/2`.
  """
  @spec validate_post_target_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_post_target_name("$server"), do: {:error, :bad_request}

  def validate_post_target_name(name), do: validate_target_name(name)

  @doc """
  Atomizes a whitelisted subset of string-keyed `params` into an
  atom-keyed attrs map — the shared PATCH/POST helper for the admin
  JSON controllers (`servers`, `users`, `networks`, `featured_channels`,
  `credentials`).

  Only keys **present** in `params` land in the result: a whitelisted
  key absent from `params` is omitted, never `nil`-filled, so an empty
  result map is a valid no-op update. Every retained key resolves via
  `String.to_existing_atom/1` — the caller MUST have already rejected
  non-whitelisted keys (extra keys → `{:error, :bad_request}`), so the
  atom is guaranteed to exist.

  The `/2` form is identity-valued — the correct behavior for a
  controller with no per-field normalization. The `/3` form threads each
  retained value through `value_fun.(key, value)`, letting a controller
  normalize a field at the boundary (e.g. `credentials` atomizes the
  `auth_method` `Ecto.Enum` string so a typo surfaces as a changeset
  validation error against the enum allowlist rather than a silent
  no-op). Both share one reduce so the whitelist semantics can never
  drift between controllers (a widened/narrowed copy is a security
  regression — CLAUDE.md "Implement once, reuse everywhere").
  """
  @spec take_atomized(map(), [String.t()]) :: map()
  def take_atomized(params, keys), do: take_atomized(params, keys, fn _, v -> v end)

  @spec take_atomized(map(), [String.t()], (String.t(), term() -> term())) :: map()
  def take_atomized(params, keys, value_fun) do
    Enum.reduce(keys, %{}, fn key, acc ->
      case Map.fetch(params, key) do
        {:ok, v} -> Map.put(acc, String.to_existing_atom(key), value_fun.(key, v))
        :error -> acc
      end
    end)
  end
end
