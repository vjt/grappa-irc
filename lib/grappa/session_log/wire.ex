defmodule Grappa.SessionLog.Wire do
  @moduledoc """
  Wire projection of a `Grappa.SessionLog.Event` row (#215) — single
  source of truth for the JSON shape emitted by the three doors: REST
  (`GET /admin/session_log`), PubSub broadcast, and the admin Channel
  push. Mirrors `Grappa.Scrollback.Wire` / `Grappa.AdminEvents.Wire`.

  `event` + `subject_kind` are kept as atoms in `t/0` (the closed sets);
  `Jason` stringifies them at the JSON boundary, and
  `mix grappa.gen_wire_types` pins the LITERAL string unions in
  `cicchetto/src/lib/wireTypes.ts` (same atom-through convention as
  `Scrollback.Wire`'s `kind`). `at` is a `DateTime` → ISO-8601 string.
  """

  alias Grappa.SessionLog.Event

  @type t :: %{
          id: integer(),
          session_id: String.t(),
          event: Grappa.SessionLog.event(),
          subject_kind: :user | :visitor,
          network_id: integer(),
          network_slug: String.t() | nil,
          nick: String.t() | nil,
          reason: String.t() | nil,
          clean: boolean() | nil,
          duration_ms: integer() | nil,
          delay_ms: integer() | nil,
          attempt: integer() | nil,
          at: DateTime.t()
        }

  @typedoc "Broadcast / channel-push envelope for a single new entry."
  @type event :: %{kind: :session_log_event, entry: t()}

  @typedoc "REST list envelope — `GET /admin/session_log`."
  @type list_result :: %{session_log: [t()]}

  @doc "Renders one persisted `Event` to its public wire shape."
  @spec to_json(Event.t()) :: t()
  def to_json(%Event{} = e) do
    %{
      id: e.id,
      session_id: e.session_id,
      event: e.event,
      subject_kind: e.subject_kind,
      network_id: e.network_id,
      network_slug: e.network_slug,
      nick: e.nick,
      reason: e.reason,
      clean: e.clean,
      duration_ms: e.duration_ms,
      delay_ms: e.delay_ms,
      attempt: e.attempt,
      at: e.at
    }
  end

  @doc "Wraps one new `Event` as the `\"event\"` channel-push payload."
  @spec entry_payload(Event.t()) :: event()
  def entry_payload(%Event{} = e), do: %{kind: :session_log_event, entry: to_json(e)}

  @doc "Wraps a list of `Event` rows as the REST `%{session_log: [...]}` envelope."
  @spec list_payload([Event.t()]) :: list_result()
  def list_payload(events) when is_list(events),
    do: %{session_log: Enum.map(events, &to_json/1)}
end
