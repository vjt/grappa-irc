defmodule Grappa.Scrollback.Meta do
  @moduledoc """
  Custom `Ecto.Type` for the `Grappa.Scrollback.Message.meta` column.

  ## Why a custom type rather than `:map`

  The column stores event-type-specific structured fields that don't
  fit `Message.body` (KICK target nick, NICK_CHANGE new-nick, MODE arg
  list, etc.). The natural shape in Elixir is an atom-keyed map:
  `%{target: "alice"}`, not `%{"target" => "alice"}`.

  Plain `field :meta, :map` would force string keys throughout because
  Jason serializes atom keys to strings AND the round-trip via the
  sqlite TEXT column comes back string-keyed. Producers writing
  atom-keyed input would get atom-keyed maps via `Repo.insert/2`
  (in-memory struct, no round-trip) but string-keyed maps via
  `Repo.all/1` (DB round-trip). Two shapes via two paths — a footgun.

  This type closes the footgun by **always returning atom-keyed maps**
  to Elixir code, regardless of the access path:

    - `dump/1` (Elixir → DB): converts atom keys to strings for JSON
      storage. Producers can use atom keys naturally.
    - `load/1` (DB → Elixir): decodes Jason JSON to a string-keyed
      map, then re-atomizes any allowlisted key via an `Enum.find`
      lookup against `@known_keys` (see `normalize_key/1`).
    - `cast/1` (changeset cast): same atom-key normalization as
      `load/1` so the in-memory struct returned by `Repo.insert/2`
      matches the shape of subsequent fetches.

  ## Allowlist (`@known_keys`)

  The lookup is `Enum.find(@known_keys, &(Atom.to_string(&1) == k))`,
  not `String.to_existing_atom/1` — even safer. `to_existing_atom/1`
  depends on whether the atom has been seen before (a load-order
  dependency); the `Enum.find` shape is bounded by the allowlist size
  and never touches the global atom table at all. Either way, the goal
  is the same: attacker-controlled JSON can't inflate the atom table.
  Atoms are not garbage-collected and unbounded `String.to_atom` from
  external input is a known DoS vector.

  Per CLAUDE.md "atoms or @type t :: literal | literal — never
  untyped strings for closed sets," the allowlist enumerates every
  atom key any IRC event meta payload may carry. Adding a new kind
  with a new meta field requires extending this list — explicit
  central registry, not implicit drift.

  Keys outside the allowlist round-trip as strings (defensive: a
  forgotten producer field becomes a visible string in the map
  instead of crashing the load with `ArgumentError`). Producers
  SHOULD use only allowlisted keys; tests catch drift via shape
  assertions on fetched rows.

  ## Per-kind expected shapes

      :privmsg | :action | :topic   →  %{}                       (body carries content)
      :notice                       →  %{} OR %{numeric: 1..999, severity: :ok | :error}
                                                                 (server numerics route to :notice
                                                                  via NumericRouter; bare NOTICE has %{})
      :join    | :part              →  %{}                       (channel + sender suffice)
      :quit                         →  %{}                       (body carries optional reason)
      :nick_change                  →  %{new_nick: String.t()}
      :mode                         →  %{modes: String.t(), args: [String.t()]}
      :kick                         →  %{target: String.t()}     (body carries reason)

  Phase 1 only writes `:privmsg` rows where `meta = %{}` so Phase 1
  exercises only the empty-map path. The allowlist + atomization is
  ready for Phase 5+ presence-event producers.
  """
  use Ecto.Type

  @typedoc """
  The atom-keyed allowlist shape. The whole point of this custom Ecto
  type is the closed-set keying: schemas declaring `meta:
  Grappa.Scrollback.Meta.t()` get a Dialyzer-visible contract that says
  "these are the only atom keys producers may write." `term()` values
  because the per-kind shapes (string, [string], etc.) live in the
  moduledoc per-kind table, not in the type — encoding all six per-kind
  shapes in the type would require a discriminated union keyed on
  `Message.kind`, which is the schema's job, not this map's.
  """
  @type t :: %{optional(:target | :new_nick | :modes | :args | :numeric | :severity) => term()}

  @known_keys ~w[target new_nick modes args numeric severity]a

  @doc """
  The atom-key allowlist. Exposed so the test suite can assert that
  every key here is also present in the Logger `:metadata` allowlist
  (`config/config.exs`) — those two lists must stay in sync per
  architecture review A18, and a unit test catches drift at test time
  without runtime mutation of Logger config.
  """
  @spec known_keys() :: [:target | :new_nick | :modes | :args | :numeric | :severity, ...]
  def known_keys, do: @known_keys

  @impl Ecto.Type
  def type, do: :map

  @impl Ecto.Type
  def cast(map) when is_map(map), do: {:ok, atomize_known(map)}
  def cast(_), do: :error

  @impl Ecto.Type
  def load(map) when is_map(map), do: {:ok, atomize_known(map)}
  def load(_), do: :error

  @impl Ecto.Type
  def dump(map) when is_map(map), do: {:ok, stringify(map)}
  def dump(_), do: :error

  # Convert any atom or string key to an atom IF it's allowlisted;
  # otherwise leave it as a string. Values pass through unchanged.
  @spec atomize_known(map()) :: map()
  defp atomize_known(map) do
    Map.new(map, fn {k, v} -> {normalize_key(k), v} end)
  end

  @spec normalize_key(atom() | String.t()) :: atom() | String.t()
  defp normalize_key(k) when is_atom(k) do
    if k in @known_keys, do: k, else: Atom.to_string(k)
  end

  defp normalize_key(k) when is_binary(k) do
    case Enum.find(@known_keys, &(Atom.to_string(&1) == k)) do
      nil -> k
      atom -> atom
    end
  end

  @spec stringify(map()) :: %{optional(String.t()) => term()}
  defp stringify(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end
end
