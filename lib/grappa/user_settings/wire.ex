defmodule Grappa.UserSettings.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the per-user
  settings pushes (#348).

  One door emits this contract today: `Grappa.UserSettings`, after a
  successful write, broadcasts on `Grappa.PubSub.Topic.user/1` so the
  subject's OTHER devices mirror a change made on one of them. The REST
  response of the same write carries the identical scalar — one shape,
  two doors, per the CLAUDE.md "one feature, one code path, every door"
  rule.

  ## One event per setting, not one `settings_changed` for all

  A generic "your settings changed" push would either carry the whole
  settings blob (leaking every other key on every write) or carry
  nothing and force a re-fetch. A narrow, additive event per setting
  keeps each payload honest about what actually moved; the wire contract
  is additive-only (#447), so a second setting is a second `kind`, never
  a repurposed field.

  ## The `0` sentinel

  `Grappa.UserSettings.auto_away_debounce/0` is `nil | :disabled |
  pos_integer()`. JSON has no atoms, so `:disabled` travels as `0` —
  the same encoding `GrappaWeb.UserSettingsJSON` renders on the REST
  side. `null` stays "no preference, the server default applies".
  """

  use Boundary, top_level?: true, deps: []

  alias Grappa.UserSettings

  @typedoc """
  Wire shape of the `auto_away_debounce_changed` push (#348).

  `auto_away_debounce_seconds`: `null` = no preference, `0` = auto-away
  off, any other integer = seconds.
  """
  @type auto_away_debounce_changed_payload :: %{
          kind: :auto_away_debounce_changed,
          auto_away_debounce_seconds: non_neg_integer() | nil
        }

  @doc """
  Builds the `auto_away_debounce_changed` push payload from the stored
  preference.

  The atom `kind` is passed through unchanged: `Jason.encode!/1`
  stringifies it at the JSON edge while `mix grappa.gen_wire_types`
  emits the literal string union cic asserts against (the
  `Grappa.ServerSettings.Wire` precedent).
  """
  @spec auto_away_debounce_changed(UserSettings.auto_away_debounce()) ::
          auto_away_debounce_changed_payload()
  def auto_away_debounce_changed(:disabled),
    do: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: 0}

  def auto_away_debounce_changed(seconds)
      when is_nil(seconds) or is_integer(seconds),
      do: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: seconds}

  @typedoc """
  Wire shape of the `quit_part_reason_changed` push (issue 2150).

  `quit_part_reason`: `null` = no remembered message (QUIT falls back to
  its own `"user-disconnect"` and PART goes bare), any string = the text
  to send when the subject leaves without giving one.

  `null` is a MEANINGFUL value here rather than an absent field — it is
  how "I cleared it" travels — so the key is always present.
  """
  @type quit_part_reason_changed_payload :: %{
          kind: :quit_part_reason_changed,
          quit_part_reason: String.t() | nil
        }

  @doc """
  Builds the `quit_part_reason_changed` push payload.

  There is no encoding to do: the stored value is already a JSON scalar,
  unlike the debounce's `:disabled` atom. The builder exists anyway so
  the shape has ONE author — `mix grappa.gen_wire_types` reads it, and a
  map spelled inline at the call site would be invisible to the
  generator.
  """
  @spec quit_part_reason_changed(UserSettings.leave_reason()) ::
          quit_part_reason_changed_payload()
  def quit_part_reason_changed(reason) when is_nil(reason) or is_binary(reason),
    do: %{kind: :quit_part_reason_changed, quit_part_reason: reason}

  @typedoc """
  Wire shape of the `auto_away_reason_changed` push (issue 2150).

  `auto_away_reason`: `null` = no preference, so the bouncer keeps its
  own `Grappa.Session.AwayState.auto_away_reason/0` constant — a string
  cic deliberately does NOT mirror, for the same reason it does not
  mirror the debounce default: a copy here drifts the day it changes.
  """
  @type auto_away_reason_changed_payload :: %{
          kind: :auto_away_reason_changed,
          auto_away_reason: String.t() | nil
        }

  @doc """
  Builds the `auto_away_reason_changed` push payload. See
  `quit_part_reason_changed/1` for why a pass-through still gets a
  builder.
  """
  @spec auto_away_reason_changed(UserSettings.leave_reason()) ::
          auto_away_reason_changed_payload()
  def auto_away_reason_changed(reason) when is_nil(reason) or is_binary(reason),
    do: %{kind: :auto_away_reason_changed, auto_away_reason: reason}

  @typedoc """
  Wire shape of the `away_nick_suffix_changed` push (#1894).

  `away_nick_suffix`: `null` = the rename is OFF, which is the default and
  what every subject had before the setting existed. `null` is a VALUE
  here — it is how "I switched it off" travels — so the key is always
  present.
  """
  @type away_nick_suffix_changed_payload :: %{
          kind: :away_nick_suffix_changed,
          away_nick_suffix: String.t() | nil
        }

  @doc """
  Builds the `away_nick_suffix_changed` push payload. See
  `quit_part_reason_changed/1` for why a pass-through still gets a
  builder.
  """
  @spec away_nick_suffix_changed(UserSettings.away_nick_suffix()) ::
          away_nick_suffix_changed_payload()
  def away_nick_suffix_changed(suffix) when is_nil(suffix) or is_binary(suffix),
    do: %{kind: :away_nick_suffix_changed, away_nick_suffix: suffix}
end
