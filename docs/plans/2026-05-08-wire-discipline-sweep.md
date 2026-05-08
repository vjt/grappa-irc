# Wire-Discipline Sweep — Implementation Plan

**Cluster:** `cluster/wire-discipline-sweep`
**Worktree:** `.worktrees/wire-discipline-sweep`
**Opened:** 2026-05-08 (right after `codebase-review-fixes` deployed)
**Drives:** Architecture review 2026-05-08 Theme 1 — "CP15 B7 wire-module
rule shipped as documentation, not enforcement."
**Closes:** 6+ HIGH findings across both 2026-05-08 reviews
(arch A1/A2/A3/A4/A7/A8 + Type-system A1/A2 + Duplication A1/A5/A6).

---

## Premise

CLAUDE.md (CP15 B7, commit `6c60ffe`) elevated to hard invariant:

> PubSub broadcast + Channel push payloads MUST be JSON-encodable —
> convert structs to wire shape via a context-owned `*.Wire` module.
> Wire conversion is per-context responsibility.

`Scrollback.Wire`, `Networks.Wire`, `Accounts.Wire`, `QueryWindows.Wire`
all uphold this. Three contexts don't:

- **Session.Server** constructs 9 distinct event payloads inline (lines
  1611–2264). `window_state_payload/3` re-builds the SAME shapes for
  the cold-WS-subscribe snapshot. `grappa_channel.ex` rebuilds three
  more at the after-join push site. Byte-identicality is enforced by
  prose comments only.
- **Visitors** has NO `wire.ex`. Two inline serializer sites
  (`me_json.ex:46–53` + `auth_json.ex:41–51`) both reach into
  `%Visitor{}` directly; `password_encrypted` is one diff away from
  shipping. The shapes ALSO drift today (LoginResponse omits
  `expires_at`, MeResponse includes it).
- **Networks.broadcast_state_change/4** (just landed in
  `codebase-review-fixes` H1) builds the `connection_state_changed`
  payload inline. The fix routes through `broadcast_event/2` correctly,
  but the payload itself isn't behind a Wire fn — same gap.

Plus:

- **`Wire.message_payload/1`** emits `kind: :message` (atom) while
  every other broadcast emits `kind: "<string>"`. Encoded the same on
  the wire (Jason atom→string), but the server-side discriminator type
  is asymmetric — `subscribe.ts:292` reads `payload.kind === "message"`
  alongside `payload.kind === "topic_changed"`, making it look like
  both arms come from the same enum source. They don't.
- Three stale typespecs still declare `[Window.t()]` after CP15 B6
  switched to `Wire.windows_map()`. Same fix class as the bug CP15 B6
  closed (raw struct over PubSub crashed fastlane).
- Cic's `userTopic.ts:72–124` consumes user-topic events with `as
  string` casts. No `WireUserEvent` discriminated union; adding a new
  `kind:` produces no compile error.
- Cic's `userTopic.ts:30–47` hand-rolls `WireWindow` + `parseWindowsMap`
  — work that disappears if the server typespec publishes the
  snake_case shape and `api.ts` exports a typed `QueryWindowEntry`.

## What this cluster IS

A consistency sweep. No new behavior. Every broadcast site goes through
a context-owned Wire fn. Every user-topic event has a server-side type
literal AND a client-side discriminated union arm. Stale typespecs
caught up to the code.

## What this cluster is NOT

- Not the `server-side-pending` move (Theme 2 of arch review). Separate
  small bucket, ~quarter session, comes after.
- Not the `WindowState extraction` (Theme 3). Half session, comes after
  Theme 2.
- Not the `channels_changed` → typed-delta refactor (arch A6). Bigger
  conceptual change with cic store implications; deferred.
- Not the `network_id`-by-`slug` refactor (arch A2, 14 cic call sites).
  Bigger surface change; deferred.
- Not the `mentions_bundle` field-shape unification (arch A8). Subset
  decided in B1 (use `Scrollback.Wire.t()` per-message rec); deeper
  unification (drop sender_nick, etc.) is a separate spec.
- Not parked-spec design pass (T32 producer gap). Separate
  channel-client-polish-adjacent cluster.
- Not Phase 5 hardening backlog.

---

## Buckets

Six TDD buckets. Each bucket: failing test FIRST → implement → gates →
commit. `feedback_per_bucket_deploy` applies — deploy + healthcheck at
each bucket close.

### B1 — `Grappa.Session.Wire` extraction (~half-bucket of work)

**Goal:** Single source of truth for the 9 event payload shapes
emitted by Session.Server. apply_effects arms + `window_state_payload/3`
+ `grappa_channel.ex` after-join push helpers all call the Wire fn.

**Module:** `lib/grappa/session/wire.ex`

**Wire functions (one per `kind:`):**

| fn | kind | topic | callers |
|---|---|---|---|
| `channels_changed/0` | `"channels_changed"` | user | `maybe_broadcast_channels_changed/2` |
| `own_nick_changed/2` | `"own_nick_changed"` | user | `maybe_broadcast_own_nick_changed/2` |
| `topic_changed/3` | `"topic_changed"` | channel | apply_effects + grappa_channel.push_topic_if_cached |
| `channel_modes_changed/3` | `"channel_modes_changed"` | channel | apply_effects + grappa_channel.push_modes_if_cached |
| `members_seeded/3` | `"members_seeded"` | channel | apply_effects + grappa_channel.push_members_if_seeded |
| `joined/2` | `"joined"` | channel | apply_effects(:joined) + window_state_payload(:joined) |
| `join_failed/4` | `"join_failed"` | channel | apply_effects(:join_failed) + window_state_payload(:failed) |
| `kicked/4` | `"kicked"` | channel | apply_effects(:kicked) + window_state_payload(:kicked) |
| `away_confirmed/2` | `"away_confirmed"` | user | apply_effects(:away_confirmed) |
| `mentions_bundle/5` | `"mentions_bundle"` | user | maybe_broadcast_mentions_bundle/1 |

**Type discipline:**

```elixir
@type wire_event_kind ::
        :channels_changed
        | :own_nick_changed
        | :topic_changed
        | :channel_modes_changed
        | :members_seeded
        | :joined
        | :join_failed
        | :kicked
        | :away_confirmed
        | :mentions_bundle

@type wire_event :: %{required(:kind) => String.t(), optional(any()) => any()}

@type joined_payload :: %{
        kind: String.t(),
        network: String.t(),
        channel: String.t(),
        state: String.t()
      }

# ... per-kind typed payload, returned by each fn
```

`window_state_payload/3` (currently in `Session.Server`) becomes a
one-liner that calls the matching Wire fn for snapshot push.

**Mentions_bundle decision (closes arch A8):** the per-message map in
the bundle is a `%{server_time, channel, sender_nick, body, kind}`
projection — deliberately stripped of id/network/meta. B1 documents
this in the Wire moduledoc (justification: bundle is rendered as a
cross-channel summary view, doesn't need persistence id/network/meta;
keeping divergence small but EXPLICIT in one place). `kind` becomes
the typed `Message.kind()` post-Atom-to-string conversion (callers
pass `Message.t()` list, Wire fn projects).

**Tests:**

- `test/grappa/session/wire_test.exs` — one test per Wire fn asserting
  shape (key set + value types). One snapshot-byte-identicality
  property test: pick a (channel, state) tuple, assert
  `Wire.joined(state.network_slug, ch) == window_state_payload(state, ch, :joined)`.
- Update existing `test/grappa/session/server_test.exs` callers — no
  shape change, just dispatch through Wire.
- Update `test/grappa_web/channels/grappa_channel_test.exs` — same.

**Gates:** scripts/test.sh + scripts/credo.sh + scripts/dialyzer.sh
(standalone). No cic-side change yet.

**Commit:** `feat(session/wire): extract Grappa.Session.Wire — single source for 9 event payloads`

### B2 — `Grappa.Visitors.Wire` extraction (~quarter bucket)

**Goal:** Close the password_encrypted-leak risk + drift between
LoginResponse / MeResponse visitor shapes.

**Module:** `lib/grappa/visitors/wire.ex`

**Wire functions:**

```elixir
@type credential_json :: %{
        id: Ecto.UUID.t(),
        nick: String.t(),
        network_slug: String.t()
      }

@type t :: %{
        id: Ecto.UUID.t(),
        nick: String.t(),
        network_slug: String.t(),
        expires_at: DateTime.t() | nil
      }

@spec visitor_to_credential_json(Visitor.t()) :: credential_json()
@spec visitor_to_json(Visitor.t()) :: t()
```

`AuthJSON` (login subject path) calls `visitor_to_credential_json/1`.
`MeJSON.show(%{visitor: ...})` calls `visitor_to_json/1`. Both call
sites collapse from inline maps to a single fn call.

**Moduledoc:** points at `Networks.Wire` as the analogous redact-
protection rationale, explicitly excludes `:password_encrypted`.

**Tests:**

- `test/grappa/visitors/wire_test.exs` — one test per fn asserting
  field set. CRITICAL test: `refute Map.has_key?(visitor_to_json(v),
  :password_encrypted)` and same for `visitor_to_credential_json/1`.
  Same shape as `test/grappa/networks/wire_test.exs` if it exists.
- Update `test/grappa_web/controllers/auth_json_test.exs` +
  `test/grappa_web/controllers/me_json_test.exs` — no shape change.

**Gates:** scripts/test.sh + credo + dialyzer.

**Commit:** `feat(visitors/wire): extract Grappa.Visitors.Wire — close password_encrypted leak risk`

### B3 — `Networks.broadcast_state_change` inline payload → Wire (~quarter bucket)

**Goal:** The inline `connection_state_changed` payload at
`networks.ex:474–483` is a wire shape. It belongs in `Networks.Wire`,
not in the broadcast caller.

**Wire fn:**

```elixir
@type connection_state_event :: %{
        kind: String.t(),
        user_id: integer(),
        network_id: integer(),
        network_slug: String.t(),
        from: Credential.connection_state(),
        to: Credential.connection_state(),
        reason: String.t() | nil,
        at: DateTime.t() | nil
      }

@spec connection_state_changed_event(Credential.t(), Credential.connection_state(), Credential.connection_state(), String.t() | nil) :: connection_state_event()
def connection_state_changed_event(%Credential{...} = c, from, to, reason)
```

`Networks.broadcast_state_change/4` becomes:

```elixir
payload = Wire.connection_state_changed_event(cred, from, to, reason)
:ok = Grappa.PubSub.broadcast_event(Topic.user(user_name), payload)
```

**Tests:**

- Add to `test/grappa/networks/wire_test.exs` — assert payload shape.
- `test/grappa/networks_test.exs` — broadcast test continues to work
  (no shape change observable to consumer).

**Gates:** scripts/test.sh + credo + dialyzer.

**Commit:** `refactor(networks/wire): move connection_state_changed payload into Wire`

### B4 — Stale typespecs + `kind` atom-vs-string consistency (~quarter bucket)

**Goal:** Catch typespecs up to code; pick one `kind:` representation
and stick with it.

**Stale typespec fixes:**

1. `lib/grappa/query_windows.ex:84` — `windows :: QueryWindows.Wire.windows_map()`
   (was `%{integer() => [Window.t()]}`).
2. `lib/grappa/query_windows.ex:40` — moduledoc prose ("`windows:
   list_for_user(user_id)` ships in the broadcast payload (raw
   `[Window.t()]`)") rewritten to match.
3. `lib/grappa_web/channels/grappa_channel.ex:163` —
   `query_windows_list_payload` typedoc updated.

**Atom-vs-string fix:**

Pick **string** as the canonical `kind:` representation everywhere:

- All Wire-emitted events use string `kind:` literals.
- `Scrollback.Wire.message_payload/1` switches from `kind: :message` to
  `kind: "message"`. The encoded JSON byte-shape is unchanged
  (`Jason.encode!(:message) == "\"message\""`); the SERVER-SIDE
  discriminator type is now consistent.
- `Scrollback.Wire.event` typespec: `%{kind: String.t(), message:
  t()}`.
- Anywhere a server-side handler reads the kind atom (none expected,
  but verify), update.

**Tests:**

- `test/grappa/scrollback/wire_test.exs` — assert
  `message_payload(m).kind === "message"`.
- Existing tests caught by the change adjusted.

**Gates:** scripts/test.sh + credo + dialyzer + scripts/check.sh full
gauntlet (this bucket touches typespecs across files; PLT staleness
risk per `feedback_dialyzer_plt_staleness`).

**Commit:** `fix(wire): align kind: as string everywhere + fix three stale typespecs`

### B5 — cic `WireUserEvent` discriminated union + `QueryWindowEntry` typed export (~quarter-to-half bucket)

**Goal:** Mirror server-side typed events as a TS discriminated union;
drop `as string` casts; gain exhaustiveness via `assertNever`.

**`cicchetto/src/lib/api.ts` additions:**

```ts
// Mirrors lib/grappa/query_windows/wire.ex windows_entry
export type QueryWindowEntry = {
  id: number;
  network_slug: string;
  target_nick: string;
  last_message_at: string; // ISO-8601
};

// Mirrors lib/grappa/session/wire.ex + lib/grappa/networks/wire.ex events
// fanned out on the user-level topic.
export type WireUserEvent =
  | { kind: "channels_changed" }
  | { kind: "query_windows_list"; windows: Record<number, QueryWindowEntry[]> }
  | {
      kind: "mentions_bundle";
      network: string;
      away_started_at: string;
      away_ended_at: string;
      away_reason: string | null;
      messages: {
        server_time: number;
        channel: string;
        sender_nick: string;
        body: string | null;
        kind: string;
      }[];
    }
  | { kind: "away_confirmed"; network: string; state: "present" | "away" }
  | { kind: "own_nick_changed"; network_id: number; nick: string }
  | {
      kind: "connection_state_changed";
      user_id: number;
      network_id: number;
      network_slug: string;
      from: string;
      to: string;
      reason: string | null;
      at: string | null;
    };

export function assertNever(x: never): never {
  throw new Error(`unreachable WireUserEvent variant: ${JSON.stringify(x)}`);
}
```

**`cicchetto/src/lib/userTopic.ts` rewrite of handler signature:**

```ts
const handler = (raw: unknown) => {
  const payload = raw as WireUserEvent;
  switch (payload.kind) {
    case "channels_changed": refetchChannels(); return;
    case "query_windows_list": setQueryWindows(parseWindowsMap(payload.windows)); return;
    case "mentions_bundle": setMentionsWindow({ ...payload }); return;
    case "away_confirmed": setAwayStatus(payload.state); return;
    case "own_nick_changed": refetchNetworks(); return;
    case "connection_state_changed": refetchNetworks(); return;
    default: assertNever(payload);
  }
};
```

**`parseWindowsMap` simplification:** the server now publishes
`QueryWindows.Wire.windows_entry()` (snake_case, ISO-8601). cic's
re-shaper either disappears (if cic adopts snake_case keys) OR shrinks
to a typed `Object.entries` reduction. **Decision in B5:** keep cic's
existing camelCase store keys (changing them is surface-wide); shrink
`parseWindowsMap` to a typed reducer that consumes `QueryWindowEntry[]`
and produces the existing `Window` shape. The TYPING is the gain; the
key-shape is left for a later cic-store refactor.

**Tests:**

- `cicchetto/src/lib/userTopic.test.ts` — already exists per CP14
  scope. Add: assertNever exhaustiveness (assertion fires for unknown
  kind); each event arm dispatches correctly with typed payload.
- `cicchetto/src/lib/api.test.ts` — type-only test asserting
  `WireUserEvent` arm exhaustiveness via tsc compile.

**Gates:** scripts/bun.sh run check + scripts/bun.sh run test +
scripts/integration.sh (Playwright e2e for any UX-behavior touched —
expected: NONE, this is a typing change).

**Commit:** `feat(cic/api): WireUserEvent discriminated union + QueryWindowEntry typed export`

### B6 — Cluster close

- Full `scripts/check.sh` (mandatory full-gate exit-0 + literal tail
  paste per `feedback_landed_claim_evidence`).
- Standalone `scripts/dialyzer.sh` (per `feedback_dialyzer_plt_staleness`).
- `scripts/bun.sh run check` + `run test`.
- `scripts/integration.sh` full e2e suite.
- README currency check (no user-facing surface change in this cluster
  → expected NO-OP; if Wire-shape drift documented anywhere in
  README/DESIGN_NOTES, update).
- DESIGN_NOTES entry — chronological note that the wire-discipline
  invariant is now enforced in code.
- CP16 close note + status: complete.
- todo.md sweep — close any items resolved by this cluster.
- Rebase onto main, merge to main, push, deploy via scripts/deploy.sh
  (FROM MAIN REPO, not worktree per `scripts/deploy.sh` refusal).
- `scripts/healthcheck.sh` against prod.
- Browser smoke at `voygrappa.bad.ass` — hard reload (Cmd+Shift+R),
  verify sidebar + scrollback + members render unchanged. Run a couple
  of T32 disconnect/connect cycles to verify connection_state_changed
  still mirrors live (B3 touched the broadcast site).

**Commit:** `docs(cluster): close wire-discipline-sweep + CP16`

---

## Decisions pinned in this plan

- **D1: Atom→string for `kind:` everywhere.** String is the
  canonical representation. Wire fns return string literals.
  `Message.kind()` (Ecto.Enum atom) gets `Atom.to_string/1` at the
  Wire boundary. Justification: `kind:` is the wire-discriminator
  per CLAUDE.md "kind: STRING JSON-wire convention" comment in
  `server.ex:1903`. The ONE atom outlier (`message_payload/1`)
  becomes a string for consistency.

- **D2: Mentions_bundle per-message shape stays stripped.** Bundle is
  rendered as a cross-channel summary; doesn't need id/network/meta.
  Documented in Session.Wire moduledoc as INTENTIONAL divergence from
  `Scrollback.Wire.t()`. Bigger unification (drop sender_nick →
  sender, etc.) is a separate decision deferred to next channel-
  client-polish cluster.

- **D3: cic store-key shape unchanged.** B5 shrinks `parseWindowsMap`
  to a typed reducer but keeps cic's existing camelCase store
  shape. Re-keying the store is its own refactor.

- **D4: `connection_state_changed` payload stays as-is on the wire.**
  B3 only moves the inline map to a Wire fn. No field renames, no
  shape changes. The fix is consistency, not redesign.

- **D5: NO new boundary deps.** Wire modules are leaves of their
  context boundary. `Session.Wire` is exported from the `Grappa.Session`
  Boundary (sibling to `Wire` namespace pattern in Networks). cic
  imports nothing new server-side; type-only file additions in api.ts.

---

## Out-of-scope / parked

- `channels_changed` typed-delta refactor (arch A6). Bigger conceptual
  change with cic store implications.
- `network_id` → `slug` 14× cic refactor (arch A2). Surface-wide.
- Server-side `:pending` origination (Theme 2 — separate
  `server-side-pending` bucket).
- `Session.Server.WindowState` extraction (Theme 3 — separate
  ~half-session cluster).
- T32 parked-spec design pass (DESIGN-BLOCKED — separate
  channel-client-polish-adjacent).
- Phase 5 hardening backlog.

---

## Exit criteria

- All five Wire functions in `Session.Wire` covered by tests.
- `Visitors.Wire` exists, both inline serializers delegate.
- `Networks.broadcast_state_change` payload behind a Wire fn.
- All `kind:` discriminators are strings, server-side.
- Three stale typespecs fixed.
- cic `WireUserEvent` discriminated union covers all five user-topic
  events; `userTopic.ts` handler is exhaustive (assertNever fires on
  unknown kinds).
- `scripts/check.sh` exit 0, tail pasted in CP16.
- `scripts/dialyzer.sh` standalone exit 0.
- `scripts/bun.sh run check` + `run test` exit 0.
- Deployed + `/healthz` ok.
- Browser smoke at `voygrappa.bad.ass` confirms sidebar + scrollback +
  members + T32 connection_state still rendering.
